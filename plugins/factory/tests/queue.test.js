import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, dequeue, enqueue, listQueue, releaseLock } from '../line/queue.js'

const home = () => mkdtempSync(join(tmpdir(), 'factory-queue-'))

test('features come out in the order they went in', () => {
  const h = home()
  enqueue(h, { repo: '/r/a', id: '20261018-one' }, 1000)
  enqueue(h, { repo: '/r/b', id: '20261018-two' }, 2000)
  assert.deepEqual(listQueue(h).map((e) => e.id), ['20261018-one', '20261018-two'])
  assert.deepEqual(dequeue(h), { repo: '/r/a', id: '20261018-one' })
  assert.deepEqual(dequeue(h), { repo: '/r/b', id: '20261018-two' })
  assert.equal(dequeue(h), null)
})

test('the same feature is queued only once', () => {
  const h = home()
  enqueue(h, { repo: '/r/a', id: '20261018-one' }, 1000)
  enqueue(h, { repo: '/r/a', id: '20261018-one' }, 2000)
  assert.equal(listQueue(h).length, 1)
})

test('only one line holds the lock', () => {
  const h = home()
  assert.equal(acquireLock(h, process.pid), true)
  assert.equal(acquireLock(h, process.pid), false)
  releaseLock(h, process.pid)
  assert.equal(existsSync(join(h, 'line.lock')), false)
  assert.equal(acquireLock(h, process.pid), true)
})

test('a lock left by a dead process is taken over', () => {
  const h = home()
  writeFileSync(join(h, 'line.lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }))
  assert.equal(acquireLock(h, process.pid), true)
})

test('release does not remove a lock someone else holds', () => {
  const h = home()
  acquireLock(h, process.pid)
  releaseLock(h, 999999)
  assert.equal(existsSync(join(h, 'line.lock')), true)
})
