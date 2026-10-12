/**
 * Web Worker entrypoint for Pathfinder Engine.
 */
import { PathfinderWorkerHandler } from '@pathfinder/connector';

const handler = new PathfinderWorkerHandler();

self.onmessage = (event: MessageEvent) => {
  handler.handleMessage(event.data, (res) => {
    self.postMessage(res);
  });
};
