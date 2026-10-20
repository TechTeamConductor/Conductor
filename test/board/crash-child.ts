// Child process for the kill -9 tests: performs a fixed sequence of board operations, SIGKILLs itself at the requested
// crash point on the requested hit, and prints "ACK <n>" after every operation that RETURNED (= was acknowledged).
import { Board } from '../../src/board/index.ts';

const dir = process.env.BOARD_DIR!;
const point = process.env.CRASH_POINT || '';
const nth = Number(process.env.CRASH_NTH || '1');
const compactEvery = Number(process.env.COMPACT_EVERY || '500');
let hits = 0;
const board = Board.open({
  dir,
  compactEvery,
  fault: (p) => {
    if (p === point && ++hits === nth) process.kill(process.pid, 'SIGKILL');
  },
});
let acked = 0;
const ack = () => {
  acked++;
  process.stdout.write(`ACK ${acked}\n`);
};
const proj = board.project('CRA') ?? board.createProject({ key: 'CRA', name: 'Crash test' });
ack();
for (let i = 0; i < 12; i++) {
  const it = board.createItem({ projectId: proj.id, title: `item ${i}`, idemKey: `child-${i}` }, 'user');
  ack();
  board.addComment(it.id, `comment ${i}`, 'conductor', { idemKey: `c-${i}` });
  ack();
}
board.close();
process.stdout.write('DONE\n');
