* gulp-child

`child_process` utilities for gulp.

## Install

```sh
npm install --save-dev gulp-child
```

## Usage

```js
import gulp from 'gulp';
import child from 'gulp-child';

export const myTask = child.exec('myTask', 'some-shell-command');
```

```sh
$ gulp myTask
[gulp] Running 'myTask'...
[gulp] Finished 'myTask' in 1.23 ms
```

## API

### child.exec(taskName, command, [options])

Returns a task function that executes `command` in a child process.
The task completes when the child process exits.

### child.spawn(taskName, command, [options])

Returns a task function that executes `command` in a child process.
The task completes immediately, and allows the process to run in the background.
The child process is killed when the user presses `Ctrl-C`.
If the task is run again, the previous child process is killed and a new one is spawned.

### child.fork(name, function)

Returns a task function that manages a lifecycle of a forked process.
The function is called with an Task Controller object that behaves
as an Abort Controller.

### child.setCollapseStackTrace(enable)

Collapse stack traces from child processes. When enabled, lines of
stack traces including node_modules are summarized into a single line.

### child.setIncludePattern(test)

Sets a string, regex, or function to test whether a line of output from a child process. If it matches, the line will not be collapsed when `setCollapseStackTrace` is enabled.

### child.on(name, test, ...tasks)

Returns a task function that listens for events from a child process,
and executes tasks when the event matches the test.
The task runs forever or until aborted.
The child tasks will be called for each matching event.

### child.once(name, test, ...tasks)

Returns a task function that listens for events from a child process,
and executes tasks when the event matches the test.
The task runs once and completes when the event is matched.
The child tasks will be called only once.

### child.wait(name, test, ...tasks)

Returns a task function that waits for events from a child process,
and executes tasks when the event matches the test.
The task runs once and completes when the event is matched.

### child.abort(name)

Returns a task function that aborts a child process.

### child.kill(name, signal)

Returns a task function that sends a signal to a child process.

### child.killAll(signal)

Returns a task function that sends a signal to all child processes.

## Handling Ctrl-C

When the user presses `Ctrl-C` a number of times, it is handled as follows:

1. Aborts all tasks that are currently running, then exits.
2. Kills all tasks with `SIGINT`.
3. Forcefully kills all tasks with `SIGKILL`.
4. Exits immediately.
