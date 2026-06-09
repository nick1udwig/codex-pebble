const store = globalThis.__codexPebbleDictationMock || { instances: [] };
globalThis.__codexPebbleDictationMock = store;

export const dictationInstances = store.instances;

export function resetDictation() {
  store.instances.length = 0;
}

export default class Dictation {
  constructor(options) {
    this.options = options;
    this.started = 0;
    this.nextText = "";
    store.instances.push(this);
  }

  start() {
    this.started++;
  }

  read() {
    return this.nextText;
  }

  emitText(text) {
    this.nextText = text;
    this.options.onReadable.call(this);
  }

  emitError(error) {
    this.options.onError(error);
  }
}
