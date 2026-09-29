// Stand-in for the box's co-tenants (spec §11 "20–30% background CPU and IO"):
// ~25% CPU duty cycle (25 ms busy / 75 ms idle) plus an 8 MB fsync'd write every 2 s.
const fs = require("fs");
const buf = Buffer.alloc(8 * 1024 * 1024, 1);
setInterval(() => {
  try {
    const fd = fs.openSync("/tmp/cotenant-io", "w");
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {}
}, 2000);
function tick() {
  const end = Date.now() + 25;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  setTimeout(tick, 75);
}
tick();
console.log("[cotenant] running");
