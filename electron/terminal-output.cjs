// Coalesce small writes and pause the SSH stream when the terminal parser lags.
class TerminalOutput {
  constructor({ send, pause, resume, delay = 16, highWater = 256 * 1024 }) {
    Object.assign(this, { send, pause, resume, delay, highWater });
    this.chunks = [];
    this.bytes = 0;
    this.inFlight = 0;
    this.timer = null;
    this.paused = false;
    this.disposed = false;
  }
  push(data) {
    if (this.disposed || !data.length) return;
    this.chunks.push(data);
    this.bytes += data.length;
    if (this.bytes + this.inFlight >= this.highWater && !this.paused) {
      this.paused = true;
      this.pause();
    }
    if (this.bytes >= 64 * 1024) this.flush();
    else if (!this.timer)
      this.timer = setTimeout(() => this.flush(), this.delay);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.bytes) return;
    const data = Buffer.concat(this.chunks, this.bytes);
    this.inFlight += this.bytes;
    this.chunks = [];
    this.bytes = 0;
    this.send(data);
  }
  acknowledge(bytes) {
    if (
      this.disposed ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > this.inFlight
    )
      return;
    this.inFlight -= bytes;
    if (this.paused && this.inFlight + this.bytes < this.highWater / 2) {
      this.paused = false;
      this.resume();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    this.chunks = [];
    this.inFlight = 0;
  }
}
module.exports = { TerminalOutput };
