import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://pwa.example";
function worker({ entries = new Map(), network = async () => { throw new Error("offline"); }, storageFailure = false, names = ["pi-remote-shell-v4", "other-app-cache"], fastDeadline = false } = {}) {
  const listeners = {}, deleted = [];
  let claimed = false;
  const cache = {
    match: async key => entries.get(key)?.clone(),
    put: async (key, value) => entries.set(key, value.clone()),
    addAll: async () => {}
  };
  vm.runInNewContext(source, {
    self: { location: { origin }, addEventListener: (name, fn) => { listeners[name] = fn; },
      skipWaiting: async () => {}, clients: { claim: async () => { claimed = true; } } },
    caches: { open: async () => { if (storageFailure) throw new Error("storage denied"); return cache; },
      keys: async () => names, delete: async key => { deleted.push(key); return true; } },
    URL, Response, AbortController, setTimeout: fastDeadline ? (fn => setTimeout(fn, 1)) : setTimeout, clearTimeout, fetch: network
  });
  return {
    entries, deleted, claimed: () => claimed,
    async request(path, method = "GET") {
      let response;
      const lifetime = [];
      listeners.fetch({ request: new Request(new URL(path, origin), { method }),
        respondWith: value => { response = value; }, waitUntil: task => lifetime.push(task) });
      const result = await response;
      await Promise.all(lifetime);
      return result;
    },
    async activate() { let lifetime; listeners.activate({ waitUntil: task => { lifetime = task; } }); await lifetime; }
  };
}

test("offline query navigation and index alias use canonical cached shell", async () => {
  const w = worker({ entries: new Map([["/", new Response("cached shell")]]) });
  for (const path of ["/?transport=poll&v=4", "/index.html?transport=poll", "/"]) {
    const response = await w.request(path);
    assert.ok(response instanceof Response);
    assert.equal(await response.text(), "cached shell");
  }
});

test("empty or unavailable storage always returns a valid offline Response", async () => {
  for (const storageFailure of [false, true]) {
    const w = worker({ storageFailure });
    const navigation = await w.request("/?v=5");
    assert.equal(navigation.status, 503);
    assert.match(await navigation.text(), /href="\/recover"/);
    assert.equal((await w.request("/app.js?version=5")).status, 503);
  }
});

test("network success survives cache write failure and normalizes cache keys", async () => {
  const network = async () => new Response("new shell");
  const w = worker({ network });
  assert.equal(await (await w.request("/?transport=poll&v=5")).text(), "new shell");
  assert.equal(await w.entries.get("/").text(), "new shell");
  assert.equal(w.entries.size, 1);
  assert.equal(await (await worker({ network, storageFailure: true }).request("/")).text(), "new shell");
});

test("HTTP errors fall back to cached shell or retain the network response", async () => {
  const network = async () => new Response("server down", { status: 502 });
  assert.equal(await (await worker({ network, entries: new Map([["/", new Response("cached")]]) }).request("/?v=5")).text(), "cached");
  assert.equal((await worker({ network }).request("/")).status, 502);
});

test("API, recovery entry point, foreign origins, and POSTs bypass worker", async () => {
  const w = worker();
  for (const [path, method] of [["/api/sessions", "GET"], ["/recover", "GET"], ["/sw-reset.js", "GET"], ["https://other.example/", "GET"], ["/", "POST"]]) {
    assert.equal(await w.request(path, method), undefined);
  }
});

test("activation deletes only obsolete Pi Remote shell caches", async () => {
  const w = worker({ names: ["pi-remote-shell-v4", "pi-remote-shell-v5", "other-app-cache"] });
  await w.activate();
  assert.deepEqual(w.deleted, ["pi-remote-shell-v4"]);
  assert.equal(w.claimed(), true);
});


test("a stalled network request reaches the deadline and uses cached HTML", async () => {
  const network = (_request, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const w = worker({ network, fastDeadline: true, entries: new Map([["/", new Response("cached shell")]]) });
  assert.equal(await (await w.request("/?transport=poll")).text(), "cached shell");
});
