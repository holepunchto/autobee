module.exports = class ApplyView {
  constructor(bee, auto) {
    this.bee = bee
    this.auto = auto
    this.view = ApplyView.open(bee, auto)
  }

  static open(bee, auto) {
    return auto._handlers.open ? auto._handlers.open(bee, auto) : bee
  }

  static close(view, auto) {
    if (!auto._handlers.close) return Promise.resolve()
    return auto._handlers.close(view)
  }

  apply(userBatch) {
    return this.auto._handlers.apply(userBatch, this.view, this.auto._host)
  }

  async close() {
    await ApplyView.close(this.view, this.auto)
    await this.bee.close()
  }
}
