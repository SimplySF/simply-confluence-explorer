// A worker thread for the pool's tests: it stops with code 3 when told to, and otherwise answers.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, task }) => {
  if (task.dir === 'stop') process.exit(3);
  parentPort.postMessage({ id, result: { answered: task.dir } });
});
