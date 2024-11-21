import logger from 'gulplog'
import cp from 'child_process'
import treeKill from 'tree-kill'
import EventEmitter from 'events'
import gulp from 'gulp'
import execm from './execm.cjs'

/** @typedef {import('undertaker').TaskFunction} Task */

const clearScreen = '\x1Bc'
const green = (str) => `\x1b[32m${str}\x1b[0m`
const red = (str) => `\x1b[31m${str}\x1b[0m`
const grey = (str) => `\x1b[90m${str}\x1b[0m`
const blue = (str) => `\x1b[34m${str}\x1b[0m`
const yellow = (str) => `\x1b[33m${str}\x1b[0m`
const bold = (str) => `\x1b[1m${str}\x1b[0m`
const events = new EventEmitter()
const controllers = new Map()

let lastLineIsExternalStackTrace = false
let collapseStackTrace = false
let includePattern = (line) => false
let _quit = 0
const never = new Promise((resolve) => {
  // Never resolve
  clearTimeout(setTimeout(() => resolve))
})

/**
 * Enable or disable collapsing of stack traces.
 * @param {boolean} enable 
 */
export function setCollapseStackTrace (enable) {
  collapseStackTrace = enable
}

/**
 * Set a pattern to test for to always include in the stack trace when collapsing.
 * @param {string|RegExp|(line:string)=>boolean} test 
 */
export function setIncludePattern (test) {
  if (typeof test === 'string') {
    setIncludePattern((line) => line.includes(test))
  } else if (test instanceof RegExp) {
    setIncludePattern((line) => test.test(line))
  } else if (typeof test !== 'function') {
    throw new Error('Invalid include pattern')
  }
  includePattern = test
}

/**
 * Cleans up the output by removing clear screen commands,
 * omits extrenuous node_modules lines in call stacks,
 * bolds source files that are important,
 * labels source files as TS or JS.
 */
function formatLine (line) {
  // Remove clear screen
  line = line.split(clearScreen).join('')
  if (/^\s{4,}at/.test(line)) {
    if (line.includes('node_modules') && !includePattern(line)) {
      if (collapseStackTrace) {
        if (!lastLineIsExternalStackTrace) {
          lastLineIsExternalStackTrace = true
          return `${/^\s+/.exec(line)[0]}${grey('...')}`
        } else {
          return null
        }
      } else {
        return grey(line)
      }
    } else {
      lastLineIsExternalStackTrace = false
      line = line.replace(/\/([^/]+):/, (m, p1) => `/${bold(p1)}:`)
      if (/\.ts:/.test(line)) {
        return `${line} \x1b[44m\x1b[37mts\x1b[0m`
      } else if (/\.js:/.test(line)) {
        return `${line} \x1b[43m\x1b[30mjs\x1b[0m`
      }
    }
  }
  lastLineIsExternalStackTrace = false
  return line
}

/**
 * Pipes data from src to dst, emitting data events on ctrl.
 */
function pipe(ctrl, prefix, src, dst) {
  let last = ''
  src.on('data', data => {
    data = data.toString()
    const lines = data.split('\n')
    lines[0] = last + lines[0]
    last = lines.pop()
    lines.forEach(line => {
      if (!ctrl.signal.aborted) {
        ctrl.emit('data', line)
      }
      dst.write(`${prefix} ${formatLine(line)}\n`)
    })
  })
}

/**
 * Executes a command, piping stdout and stderr to the console.
 * Returns a promise that resolves when the command exits.
 * If the command exits with a non-zero exit code, the promise is rejected.
 * If the command is aborted, the promise is resolved.
 */
const execp = (ctrl, label, command, options) => {
  if (_quit) return never
  const { savage = false } = options || {}
  const gracePeriod = options?.gracePeriod ?? 5000
  const promise = new Promise((resolve, reject) => {
    const proc = execm(command, options)
    let errored = false
    proc.on('close', (exitCode) => {

      if (errored) return
      if (ctrl.signal.aborted) {
        logger.info(`${label}... ⚠️  Aborted`)
        resolve({ exitCode })
        return
      }
      if (exitCode) {
        logger.info(`${label}... ❌  Failed`)
        if (savage) {
          resolve({ exitCode })
        } else {
          reject(new Error(`Command \`${command}\` failed with exit code ${exitCode}`))
        }
      } else {
        logger.info(`${label}... ✅  Success`)
        resolve({ exitCode })
      }
    })

    proc.on('error', (err) => {
      errored = true
      logger.error(`${label}... ❌  Errored`)
      reject(err)
    })

    proc.on('log', (log) => {
      switch (log.level) {

        case 'debug':
          logger.debug(`${blue(`[${label}]`)} ${log.message}`)
          break

        case 'warn':
          logger.warn(`${yellow(`[${label}]`)} ${log.message}`)
          break

        case 'error':
          logger.error(`${red(`[${label}]`)} ${log.message}`)
          break

        case 'info':
        default:
          logger.info(`[${label}] ${log.message}`)
          break
      }
    })

    pipe(ctrl, green(`[${label}]`), proc.stdout, process.stdout)
    pipe(ctrl, red(`[${label}]`), proc.stderr, process.stderr)

    const kill = (signal) => {
      signal = signal || 'SIGTERM'
      if (proc.exitCode !== null) {
        logger.debug(`${label} was already killed (exit code ${proc.exitCode})`)
        return
      }
      logger.debug(`Sending ${signal} to ${label}...`)
      treeKill(proc.pid, signal)
    }

    ctrl.signal.on('abort', async () => {
      if (proc.exitCode !== null) {
        logger.debug(`${label} was already killed (exit code ${proc.exitCode})`)
        return
      }
      // Simulate Ctrl-C. If the process doesn't exit in the grace period, kill it.
      logger.debug(`Sending SIGINT to ${label}...`)
      kill('SIGINT')
      const timer = setTimeout(() => {
        logger.debug(`Sending SIGKILL to ${label}...`)
        kill('SIGKILL')
      }, gracePeriod)
      await new Promise(resolve => proc.on('close', () => {
        clearTimeout(timer)
        logger.debug(`${label} exited`)
        resolve()
      }))
      // Wait for exec to finish properly
      await promise
    })

    ctrl.signal.on('kill', async (signal) => {
      if (proc.exitCode !== null) {
        logger.debug(`${label} was already killed (exit code ${proc.exitCode})`)
        return
      }
      logger.info(`Killing ${label}...`)
      kill(signal)
      // Wait for exec to finish properly
      await promise
      logger.info(`Killed ${label}`)
    })
  })
  return promise
}

class TaskController {
  _name;
  _aborted = false;
  _aborters = new Set();
  _abort;
  _killers = new Set();
  _promise;
  _resolve;
  constructor(name) {
    this._name = name
    this._promise = new Promise((resolve)=>{
        this._resolve = resolve;
    });
  }
  get name() {
    return this._name;
  }
  get signal() {
    return {
      aborted: this._aborted,
      on: (event, fn)=>{
        switch (event) {
          case 'abort':
            if (this._aborted) {
              throw new Error('Cannot add event listener to an aborted signal.');
            }
            this._aborters.add(fn);
            break
          case 'kill':
            this._killers.add(fn);
            break;
          default:
            throw new Error(`Unknown event ${event}`);
        }
      },
      off: (event, fn)=>{
        switch (event) {
          case 'abort':
            this._aborters.delete(fn);
            break
          case 'kill':
            this._killers.delete(fn);
            break;
          default:
            throw new Error(`Unknown event ${event}`);
        }
      }
    };
  }

  /**
   * Aborts the task, calling all aborters. Returns a promise that resolves when all aborters have resolved.
   * If called multiple times, returns the same promise.
   */
  async abort() {
    if (this._abort) return this._abort;
    this._aborted = true;
    logger.info(`Aborting ${this._name}...`)
    this._abort = Promise.all([
        ...this._aborters
    ].map((fn)=>fn()));
    await this._abort;
    logger.info(`Aborted ${this._name}`)
    this._resolve();
  }

  /**
   * Kills the task, calling all killers. Returns a promise that resolves when all killers have resolved.
   * If called multiple times, calls the killers again.
   * @param {string} signal Signal to send to the task. Defaults to SIGTERM.
   */
  async kill(signal = 'SIGTERM') {
    await Promise.all([
        ...this._killers
    ].map((fn)=>fn(signal)));
  }
  get promise() {
    return this._promise;
  }
  emit(event, ...args) {
    events.emit(`${this._name}:${event}`, ...args)
  }
}

/**
 * Defines a task that can be aborted and run again.
 * @param {string} name Name of the task
 * @param {function(TaskController):Promise} fn Function to execute
 */
export function fork (name, fn) {
  const task = async () => {
    const newCtrl = new TaskController(name)
    if (controllers.has(name)) {
      logger.info(`${name} was already running. Aborting...`)
      const ctrl = controllers.get(name)
      controllers.set(name, newCtrl)
      await ctrl.abort()
    } else {
      controllers.set(name, newCtrl)
    }
    if (!newCtrl.signal.aborted) {
      fn(newCtrl).then(() => {
        if (controllers.get(name) === newCtrl) {
          controllers.delete(name)
        }
      })
    }
    if (_quit) await never
  }
  task.displayName = name
  return task
}

/**
 * Defines a task that executes a command and finishes when the command finishes.
 * @param {string} name Name of the task
 * @param {string} command Command to execute
 * @param {Object} options Options to pass to `child_process.exec`
 */
export function exec (name, command, options) {
  const task = async () => {
    try {
      logger.info(`Executing ${command}...`)
      const ctrl = new TaskController(name)
      controllers.set(name, ctrl)
      await execp(ctrl, name, command, options)
      logger.info(`Finished ${command}`)
    } finally {
      controllers.delete(name)
      if (_quit) await never
    }
  }
  task.displayName = name
  return task
}

/**
 * Defines a task that executes a command and finishes immediately, leaving the process running.
 * The task can be aborted and run again.
 * @param {string} name Name of the task
 * @param {string} command Command to execute
 * @param {Object} options Options to pass to `child_process.exec`
 */
export function spawn (name, command, options) {
  return fork(name, async (ctrl) => {
    logger.info(`Executing ${command}...`)
    await execp(ctrl, name, command, options)
    logger.info(`Finished ${command}`)
    if (_quit) await never
  })
}

let onCount = 0
/**
 * Defines a task that watches the output of an other task and fires off child tasks when certain text is seen in the output. This task completes when aborted.
 * @param {string} name Name of the task to watch
 * @param {RegExp|Function|string} test Text to look for in the output.
 * @param {...any} tasks Tasks to run when the text is seen
 * @returns {Task}
 */
export function on (name, test, ...tasks) {
  const childTask = tasks.length
    ? gulp.series(...tasks)
    : gulp.series(async () => {})
  return fork(`on:${name}${onCount++ ? `:${onCount}` : ''}`, async function (ctrl) {
    const listener = (line) => {
      logger.debug(`Received data from ${name}: ${line}`)
      if (
        (test instanceof RegExp && test.test(line))
        || (typeof test === 'function' && test(line))
        || (typeof test === 'string' && line.includes(test))
      ) {
        logger.debug(`Triggered by ${line}`)
        childTask()
      }
    }
    events.on(`${name}:data`, listener)
    await ctrl.promise
    events.off(`${name}:data`, listener)
    if (_quit) await never
  })
}

let onceCount = 0
/**
 * Defines a task that watches the output of another task and fires off a child task when certain text is seen in the output. Resolves when the child task completes.
 * @param {string} name Name of the task to watch
 * @param {RegExp|Function|string} test Text to look for in the output
 * @param  {...any} tasks Tasks to run when the text is seen
 * @returns {Task}
 */
export function once (name, test, ...tasks) {
  const childTask = tasks.length
    ? gulp.series(...tasks)
    : gulp.series(async () => {})
  return fork(`once:${name}${onceCount++ ? `:${onceCount}`: ''}`, async function(ctrl) {
    const listener = (line) => {
      if (
        (test instanceof RegExp && test.test(line))
        || (typeof test === 'function' && test(line))
        || (typeof test === 'string' && line.includes(test))
      ) {
        events.off(`${name}:data`, listener)
        logger.debug(`Triggered by ${line}`)
        childTask(ctrl)
      }
    }
    events.on(`${name}:data`, listener)
    await ctrl.promise
    events.off(`${name}:data`, listener)
    if (_quit) await never
  })
}

// let waitCount = 0
// /**
//  * Defines a task that watches the output of another task and optionally fires off a child task when certain text is seen in the output. Resolves when the child task completes.
//  * @param {string} name Name of the task to watch
//  * @param {RegExp|Function|string} test Text to look for in the output
//  * @param  {...any} tasks Tasks to run when the text is seen
//  * @returns {Task}
//  */
// export function wait (name, test, ...tasks) {
//   const childTask = tasks.length
//     ? gulp.series(...tasks)
//     : gulp.series(async () => {})
//   const task = function(cb) {
//     const listener = (line) => {
//       if (
//         (test instanceof RegExp && test.test(line))
//         || (typeof test === 'function' && test(line))
//         || (typeof test === 'string' && line.includes(test))
//       ) {
//         events.off(`${name}:data`, listener)
//         logger.debug(`Triggered by ${line}`)
//         childTask(cb)
//       }
//     }
//     events.on(`${name}:data`, listener)
//   }
//   task.displayName = `wait:${name}${waitCount++ ? `:${waitCount}` : ''}`
//   return task
// }

/**
 * Defines a task that kills a forked task when called.
 * @param {string} name Name of the task to kill
 * @returns {Task}
 */
export function kill (name, signal = 'SIGTERM') {
  const task = async function () {
    if (controllers.has(name)) {
      logger.info(`Killing ${name} with ${signal}...`)
      const ctrl = controllers.get(name)
      await ctrl.kill(signal)
      logger.info(`Killed ${name}`)
    }
  }
  task.displayName = `kill:${name}:${signal}`
  return task
}

export function killAll (signal = 'SIGTERM') {
  const task = async function () {
    logger.info(`Killing all tasks...`)
    await Promise.all([...controllers.values()].map(async ctrl => {
      logger.info(`Killing ${ctrl.name}...`)
      await ctrl.kill(signal)
      logger.info(`Killed ${ctrl.name}`)
    }))
  }
  task.displayName = `killAll:${signal}`
  return task
}

export function abort (name) {
  const task = async function () {
    if (controllers.has(name)) {
      logger.info(`Aborting ${name}...`)
      const ctrl = controllers.get(name)
      await ctrl.abort()
      logger.info(`Aborted ${name}`)
    }
  }
  task.displayName = `abort:${name}`
}

async function quit(signal) {
  switch (_quit++) {
    case 0:
      logger.info(`Aborting all tasks...`)
      await Promise.all([...controllers.values()].map(async ctrl => {
        await ctrl.abort()
      }))
      logger.info('Finished gracefully')
      process.exit(0)
      break
    case 1:
      logger.info(`Killing all tasks...`)
      await Promise.all([...controllers.values()].map(async ctrl => {
        await ctrl.kill(signal)
      }))
      break
    case 2:
      logger.info(`Forcefully killing all tasks...`)
      await Promise.all([...controllers.values()].map(async ctrl => {
        await ctrl.kill('SIGKILL')
      }))
      logger.info('Finished forcefully')
      process.exit(1)
      break
    case 3:
      logger.info(`Exiting immediately...`)
      process.exit(1)
  }
}

process.on('SIGINT', () => quit('SIGINT'))
process.on('SIGTERM', () => quit('SIGTERM'))
process.on('SIGQUIT', () => quit('SIGQUIT'))
