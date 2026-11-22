// Apps Script has synchronous services and no browser event loop.
export class Immediate {
  constructor(executor) {
    this.state = 'pending';
    try {
      executor(value => { this.state = 'fulfilled'; this.value = value; }, error => { this.state = 'rejected'; this.value = error; });
    } catch (error) { this.state = 'rejected'; this.value = error; }
  }
  static resolve(value) { return value instanceof Immediate ? value : new Immediate(resolve => resolve(value)); }
  static reject(error) { return new Immediate((_, reject) => reject(error)); }
  static all(values) { return new Immediate((resolve, reject) => { try { resolve(values.map(unwrap)); } catch (error) { reject(error); } }); }
  then(success, failure) {
    return new Immediate((resolve, reject) => {
      try {
        if (this.state === 'pending') throw new Error('Asynchronous initialization is not supported in Apps Script');
        if (this.state === 'rejected' && !failure) return reject(this.value);
        const handler = this.state === 'fulfilled' ? success : failure;
        resolve(unwrap(handler ? handler(this.value) : this.value));
      } catch (error) { reject(error); }
    });
  }
  catch(failure) { return this.then(undefined, failure); }
}
export function unwrap(value) {
  while (value && typeof value.then === 'function') {
    if (value instanceof Immediate) {
      if (value.state === 'rejected') throw value.value;
      if (value.state !== 'fulfilled') throw new Error('Pending asynchronous operation');
      value = value.value;
    } else {
      let done = false, failure, result;
      value.then(v => { result = v; done = true; }, e => { failure = e; done = true; });
      if (!done) throw new Error('Pending asynchronous operation');
      if (failure) throw failure;
      value = result;
    }
  }
  return value;
}
export function gasThen(call, success, failure) { return Immediate.resolve(call()).then(success, failure); }
export function gasCatch(call, failure) { try { return unwrap(call()); } catch (error) { return failure(error); } }

export class Utf8Encoder {
  encode(value) { return Uint8Array.from(unescape(encodeURIComponent(value)), x => x.charCodeAt(0)); }
}
export class Utf8Decoder {
  decode(value) {
    let text = '';
    for (let i = 0; i < value.length; i += 8192) text += String.fromCharCode(...value.subarray(i, i + 8192));
    return decodeURIComponent(escape(text));
  }
}
