const store = globalThis.__codexPebbleMessageMock || { instances: [] };
globalThis.__codexPebbleMessageMock = store;

export const messageInstances = store.instances;

export function resetMessages() {
  store.instances.length = 0;
}

export default class Message {
  constructor(options) {
    this.options = options;
    this.nextMessage = new Map();
    this.requestedConfig = false;
    this.writes = [];
    store.instances.push(this);
  }

  read() {
    return this.nextMessage;
  }

  write(message) {
    this.writes.push(message);
  }

  emitReadable(message) {
    this.nextMessage = message;
    this.options.onReadable.call(this);
  }

  emitWritable() {
    this.options.onWritable.call(this);
  }
}
