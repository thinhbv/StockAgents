import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createEventsRepo } from '@stockagents/db';
import { createSseHub } from '../src/stream/sse.js';

let client, eventsRepo;

// Giả lập http.ServerResponse: ghi lại mọi thứ được ghi ra.
function fakeRes() {
  const chunks = [];
  return {
    chunks,
    headersSent: null,
    writeHead(status, headers) { this.headersSent = { status, headers }; },
    write(s) { chunks.push(s); return true; },
    end() { this.ended = true; },
    on() {},
    get text() { return chunks.join(''); },
  };
}

before(async () => {
  client = await withTestDb();
  eventsRepo = createEventsRepo(client);
});
beforeEach(async () => { await resetTables(client, ['event_log']); });
after(async () => { await client.close(); });

test('attach đặt đúng header SSE', async () => {
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, 0);

  assert.equal(res.headersSent.status, 200);
  assert.match(res.headersSent.headers['content-type'], /text\/event-stream/);
  assert.equal(res.headersSent.headers['cache-control'], 'no-cache');
  hub.stop();
});

test('broadcast gửi sự kiện đúng định dạng SSE kèm id', async () => {
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, 0);

  hub.broadcast({ id: 42, type: 'trigger.fired', agentId: 'a1', payload: { x: 1 } });

  assert.match(res.text, /^id: 42$/m);
  assert.match(res.text, /^event: trigger\.fired$/m);
  assert.match(res.text, /^data: \{.*"x":1.*\}$/m);
  hub.stop();
});

test('attach PHÁT LẠI sự kiện đã bỏ lỡ theo Last-Event-ID', async () => {
  const a = await eventsRepo.appendEvent({ type: 'e1', payload: {} });
  await eventsRepo.appendEvent({ type: 'e2', payload: {} });
  await eventsRepo.appendEvent({ type: 'e3', payload: {} });

  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, a.id);   // đã thấy tới e1

  assert.match(res.text, /event: e2/);
  assert.match(res.text, /event: e3/);
  assert.equal(/event: e1/.test(res.text), false, 'không phát lại cái đã thấy');
  hub.stop();
});

test('không có khoảng trống: sự kiện chèn giữa lịch sử và realtime vẫn tới', async () => {
  await eventsRepo.appendEvent({ type: 'cu', payload: {} });
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();

  await hub.attach(res, 0);
  hub.broadcast({ id: 99, type: 'moi', agentId: null, payload: {} });

  assert.match(res.text, /event: cu/);
  assert.match(res.text, /event: moi/);
  hub.stop();
});

test('clientCount tăng giảm đúng', async () => {
  const hub = createSseHub({ eventsRepo });
  assert.equal(hub.clientCount(), 0);
  await hub.attach(fakeRes(), 0);
  await hub.attach(fakeRes(), 0);
  assert.equal(hub.clientCount(), 2);
  hub.stop();
  assert.equal(hub.clientCount(), 0);
});

test('broadcast tới MỌI client đang kết nối', async () => {
  const hub = createSseHub({ eventsRepo });
  const a = fakeRes(); const b = fakeRes();
  await hub.attach(a, 0); await hub.attach(b, 0);

  hub.broadcast({ id: 7, type: 'chung', agentId: null, payload: {} });
  assert.match(a.text, /event: chung/);
  assert.match(b.text, /event: chung/);
  hub.stop();
});

test('client ghi lỗi bị gỡ khỏi danh sách, không làm hỏng client khác', async () => {
  const hub = createSseHub({ eventsRepo });
  const bad = fakeRes();
  bad.write = () => { throw new Error('socket đã đóng'); };
  const good = fakeRes();
  await hub.attach(bad, 0); await hub.attach(good, 0);

  assert.doesNotThrow(() => hub.broadcast({ id: 1, type: 'x', agentId: null, payload: {} }));
  assert.equal(hub.clientCount(), 1);
  assert.match(good.text, /event: x/);
  hub.stop();
});

test('payload nhiều dòng vẫn đúng khuôn SSE', async () => {
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, 0);

  hub.broadcast({ id: 5, type: 'x', agentId: null, payload: { reason: 'dòng một\ndòng hai' } });
  const dataLines = res.text.split('\n').filter(l => l.startsWith('data: '));
  assert.equal(dataLines.length, 1, 'xuống dòng trong payload không được phá khuôn SSE');
  hub.stop();
});

test('giới hạn số client đồng thời', async () => {
  const hub = createSseHub({ eventsRepo, maxClients: 2 });
  await hub.attach(fakeRes(), 0);
  await hub.attach(fakeRes(), 0);
  const third = fakeRes();
  await hub.attach(third, 0);

  assert.equal(hub.clientCount(), 2);
  assert.equal(third.headersSent.status, 503);
  hub.stop();
});
