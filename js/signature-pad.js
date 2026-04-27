export class SignaturePad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drawing = false;
    this.lastX = 0;
    this.lastY = 0;
    this.lineWidth = 2.5;
    this.color     = '#1e293b';
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('mousedown', e => this._start(e));
    c.addEventListener('mousemove', e => this._draw(e));
    c.addEventListener('mouseup', () => { this.drawing = false; });
    c.addEventListener('mouseleave', () => { this.drawing = false; });

    c.addEventListener('touchstart', e => { e.preventDefault(); this._start(e.touches[0]); }, { passive: false });
    c.addEventListener('touchmove', e => { e.preventDefault(); this._draw(e.touches[0]); }, { passive: false });
    c.addEventListener('touchend', () => { this.drawing = false; });
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.canvas.width / r.width),
      y: (e.clientY - r.top)  * (this.canvas.height / r.height),
    };
  }

  _start(e) {
    const { x, y } = this._pos(e);
    this.drawing = true;
    this.lastX = x;
    this.lastY = y;
    this.ctx.beginPath();
    this.ctx.arc(x, y, this.lineWidth / 2, 0, Math.PI * 2);
    this.ctx.fillStyle = this.color;
    this.ctx.fill();
  }

  _draw(e) {
    if (!this.drawing) return;
    const { x, y } = this._pos(e);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(this.lastX, this.lastY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    this.lastX = x;
    this.lastY = y;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  isEmpty() {
    return !this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
      .data.some(v => v !== 0);
  }

  toDataURL() {
    return this.canvas.toDataURL('image/png');
  }
}
