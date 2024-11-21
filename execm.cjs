const child_process = require('child_process')
const stream = require('stream')
const EventEmitter = require('events')
const kill = require('tree-kill')

const signals = [
  'SIGABRT',
  'SIGALRM',
  'SIGBUS',
  'SIGCHLD',
  'SIGCLD',
  'SIGCONT',
  'SIGEMT',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINFO',
  'SIGINT',
  'SIGIO',
  'SIGIOT',
  // 'SIGKILL',
  'SIGLOST',
  'SIGPIPE',
  'SIGPOLL',
  // 'SIGPROF',
  'SIGPWR',
  'SIGQUIT',
  // 'SIGSEGV',
  'SIGSTKFLT',
  // 'SIGSTOP',
  'SIGTSTP',
  'SIGSYS',
  'SIGTERM',
  'SIGTRAP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGUNUSED',
  'SIGURG',
  // 'SIGUSR1',
  // 'SIGUSR2',
  'SIGVTALRM',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGWINCH'
]

function execm(command, options) {
  const stacker = new Error()
  const isFork = process.send !== undefined

  if (!isFork) {
    const child = child_process.fork(__filename, [], { execArgv: [] })
    const stdoutStream = new stream.PassThrough()
    const stderrStream = new stream.PassThrough()
    const events = new EventEmitter()

    const logger = (level, message) => {
      events.emit('log', { level, message })
    }
    logger.debug = message => logger('debug', message)
    logger.info = message => logger('info', message)
    logger.warn = message => logger('warn', message)
    logger.error = message => logger('error', message)

    let closed = false
    const keepAliveTimer = setInterval(() => {
      if (child.connected) {
        child.send({ type: 'keepAlive' })
      } else {
        clearInterval(keepAliveTimer)
      }
    }, 1000)
    const close = (exitCode) => {
      if (!closed) {
        closed = true
        stdoutStream.end()
        stderrStream.end()
        events.emit('close', exitCode)
        clearInterval(keepAliveTimer)
        if (child.connected) {
          child.disconnect()
        }
      }
    }
    child.on('message', message => {
      const { pid, stdout, stderr, exitCode, error, log } = message

      if (pid === child.pid) {
        if (stdout && !closed) stdoutStream.write(stdout)
        if (stderr && !closed) stderrStream.write(stderr)
        if (log) {
          events.emit('log', log)
        }
        if (exitCode !== undefined) {
          childProcess.exitCode = exitCode
          child.removeAllListeners('message')
          close(exitCode)
        }
        if (error) {
          const err = new Error(error)
          err.stack = `${err.message}\n${stacker.stack.substring(stacker.stack.indexOf('\n') + 1)}`
          events.emit('error', err)
          close(1)
        }
      }
    })

    child.on('close', () => {
      close(0)
      for (const signal of signals) {
        process.removeListener(signal, handleSignal)
      }
    })

    child.on('error', error => {
      events.emit('error', error)
    })

    const handleSignal = signal => child.kill(signal)

    // for (const signal of signals) {
    //   process.on(signal, handleSignal)
    // }

    const childProcess = Object.create(child, {
      pid: { get: () => child.pid },
      exitCode: { get: () => child.exitCode },
      stderr: { get: () => stderrStream },
      stdout: { get: () => stdoutStream },
      on: { value: (event, listener) => events.on(event, listener) },
      removeListener: { value: (event, listener) => events.removeListener(event, listener) },
      removeAllListeners: { value: event => events.removeAllListeners(event) }
    })

    child.send({ type: 'execm', command, options })

    return childProcess
  } else {

    const logger = (level, message) => {
      try {
        if (process.connected) {
          process.send({ pid: process.pid, log: { level, message } })
        } else {
          throw new Error('Not connected')
        }
      } catch (err) {
        switch (level) {
          case 'error':
            console.error(`[DISCONNECTED] ${message}`)
            break
          case 'warn':
            console.warn(`[DISCONNECTED] ${message}`)
            break
          case 'debug':
            console.debug(`[DISCONNECTED] ${message}`)
            break
          case 'info':
          default:
            console.log(`[DISCONNECTED] ${message}`)
        }
      }
    }
    logger.debug = message => logger('debug', message)
    logger.info = message => logger('info', message)
    logger.warn = message => logger('warn', message)
    logger.error = message => logger('error', message)

    const newOptions = {
      shell: true,
      ...options
    }

    logger.debug(`Executing \`${command}\`...`)
    const childProcess = child_process.spawn(command, newOptions)
    childProcess.on('close', exitCode => {
      if (process.connected) {
        try {
          process.send({ pid: process.pid, exitCode })
        } catch (err) {
          // Ignore
        }
      } else {
        // Ignore
      }
    })
    childProcess.on('error', error => {
      if (process.connected) {
        try {
          process.send({ pid: process.pid, error: error.message })
        } catch (err) {
          // Ignore
        }
      } else {
        console.error(`Unable to execute \`${command}\`: ${error.message}`)
      }
      process.exit(1)
    })
    childProcess.stdout.on('data', data => {
      if (process.connected) {
        try {
          process.send({ pid: process.pid, stdout: data.toString() })
        } catch (err) {
          // Ignore
        }
      } else {
        // Ignore
        // process.stdout.write(data.toString())
      }
    })
    childProcess.stderr.on('data', data => {
      if (process.connected) {
        try {
          process.send({ pid: process.pid, stderr: data.toString() })
        } catch (err) {
          // Ignore
        }
      } else {
        // Ignore
        // process.stderr.write(data.toString())
      }
    })

    // Monitor the parent process. If it exits, kill the child processes.
    const killTimer = setInterval(() => {
      try {
        process.kill(process.ppid, 0)
      } catch (error) {
        if (childProcess.pid) {
          logger.warn(`Parent process ${process.ppid} has exited. Killing ${childProcess.pid}...`)
          kill(childProcess.pid, 'SIGKILL')
        } else {
          logger.warn(`Parent process ${process.ppid} has exited. Exiting...`)
          process.exit(1)
        }
      }
    }, 1000)

    // Keep-Alive
    let keepAliveTimeout = null

    const keepAlive = () => {
      if (keepAliveTimeout) {
        clearTimeout(keepAliveTimeout)
      }
      keepAliveTimeout = setTimeout(() => {
        if (childProcess.pid) {
          logger.warn(`Have not received keep-alive from parent in 5 seconds. Killing ${childProcess.pid}...`)
          kill(childProcess.pid, 'SIGKILL')
        } else {
          logger.warn(`Have not received keep-alive from parent in 5 seconds. Exiting...`)
          process.exit(1)
        }
      }, 5000)
    }

    process.on('message', message => {
      if (message.type === 'keepAlive') {
        keepAlive()
      }
    })
    

    const handleSignal = (signal) => {
      childProcess.kill(signal)
    }

    for (const signal of signals) {
      process.on(signal, handleSignal)
    }

    childProcess.on('exit', () => {
      logger.info(`Child process ${childProcess.pid} has exited.`)
      clearTimeout(killTimer)
      clearTimeout(keepAliveTimeout)
      for (const signal of signals) {
        process.removeListener(signal, handleSignal)
      }
    })

    return childProcess
  }
}

function main() {
  process.on('message', message => {
    if (message.type === 'execm') {
      const { command, options } = message
      execm(command, options)
    }
  })
}

if (require.main === module) {
  main()
}

module.exports = execm
