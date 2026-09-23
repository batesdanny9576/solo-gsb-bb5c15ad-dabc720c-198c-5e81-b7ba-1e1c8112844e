/* Headless smoke test for undo/redo history in static/app.js.
 * Uses minimal DOM stubs + an in-memory API store; run with: node test/undo.test.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

// ---- tiny DOM stubs -------------------------------------------------------
function makeEl(id) {
  const listeners = {};
  const handlerProp = (name) => ({
    enumerable: true,
    get() { return listeners[name]?.[listeners[name].length - 1]; },
    set(fn) { listeners[name] = fn ? [fn] : []; },
  });
  const el = {
    id, style: {}, dataset: {}, value: "", innerHTML: "", textContent: "",
    parentElement: null, __listeners: listeners,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    querySelector: () => makeEl("child"),
    querySelectorAll: () => [],
    closest: () => null,
  };
  Object.defineProperties(el, {
    onclick: handlerProp("click"),
    oninput: handlerProp("input"),
    onchange: handlerProp("change"),
  });
  el.parentElement = el;
  return el;
}

const els = new Map();
const getEl = (sel) => {
  const key = typeof sel === "string" ? sel : String(sel);
  if (!els.has(key)) els.set(key, makeEl(key));
  return els.get(key);
};

const docListeners = {};
const documentStub = {
  querySelector: (sel) => getEl(sel),
  querySelectorAll: () => [],
  getElementById: (id) => getEl("#" + id),
  createElement: () => makeEl("created"),
  createElementNS: () => makeEl("created-ns"),
  addEventListener(t, fn) { docListeners[t] = fn; },
  elementFromPoint: () => null,
  body: makeEl("body"),
};
const winListeners = {};
const windowStub = { addEventListener: (t, fn) => { winListeners[t] = fn; } };

// ---- in-memory API store ---------------------------------------------------
const store = { seq: 0, scripts: [] };
function iso() { return new Date().toISOString(); }
async function fakeFetch(url, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  let status = 200, data = null;
  const mId = url.match(/^\/api\/scripts\/(\d+)(\/(validate|export|share))?$/);
  if (url === "/api/scripts" && method === "GET") {
    data = store.scripts.map((s) => ({ id: s.id, name: s.name, created_at: s.created_at, updated_at: s.updated_at }));
  } else if (url === "/api/scripts" && method === "POST") {
    const s = { id: ++store.seq, name: body.name, content: body.content, created_at: iso(), updated_at: iso() };
    store.scripts.push(s); status = 201; data = s;
  } else if (mId && !mId[3] && method === "GET") {
    data = store.scripts.find((s) => s.id === Number(mId[1]));
  } else if (mId && !mId[3] && method === "PUT") {
    const s = store.scripts.find((x) => x.id === Number(mId[1]));
    s.name = body.name; s.content = body.content; s.updated_at = iso(); data = s;
  } else if (mId && mId[3] === "validate") {
    data = { cycles: [], orphans: [], uncovered: [], errors: [], ok: true };
  } else if (mId && method === "DELETE") {
    store.scripts = store.scripts.filter((x) => x.id !== Number(mId[1]));
    status = 204;
  } else {
    throw new Error("unhandled fetch " + method + " " + url);
  }
  return { ok: status < 400, status, json: async () => data };
}

// ---- load common.js + app.js in a shared VM context -----------------------
const common = fs.readFileSync(path.join(__dirname, "..", "static", "common.js"), "utf8");
const code = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const sandbox = {
  document: documentStub, window: windowStub, fetch: fakeFetch,
  console, setTimeout, clearTimeout, Date, Math, JSON, confirm: () => true,
  navigator: { clipboard: {} }, URL: { createObjectURL: () => "", revokeObjectURL() {} },
  Blob: function () {},
};
vm.createContext(sandbox);
vm.runInContext(
  common + "\n" + code + "\nglobalThis.__t = { state, history, addNode, undo, redo, saveScript, openScript, renderInspector, getNode };",
  sandbox,
);

(async () => {
  await new Promise((r) => setTimeout(r, 20)); // let init() IIFE settle (creates sample script)
  const t = sandbox.__t;
  const { state, history } = t;
  const btnUndo = getEl("#btnUndo"), btnRedo = getEl("#btnRedo");
  const nodeCount = () => state.doc.content.nodes.length;

  // initial: sample script with 5 nodes, history empty of edits
  assert(nodeCount() === 5, "sample script should load with 5 nodes");
  assert(history.stack.length === 1 && history.index === 0, "history cleared after open (1 baseline entry)");
  assert(state.dirty === false, "freshly opened script not dirty");
  assert(btnUndo.disabled === true && btnRedo.disabled === true, "undo/redo disabled initially");

  // node add -> undo -> redo
  t.addNode();
  assert(nodeCount() === 6, "add node");
  assert(history.stack.length === 2, "add node = 1 history item");
  assert(state.dirty === true, "add node marks unsaved");
  assert(btnUndo.disabled === false, "undo enabled after edit");
  t.undo();
  assert(nodeCount() === 5, "undo removes added node");
  assert(state.dirty === false, "undo back to saved version clears unsaved flag");
  assert(btnUndo.disabled === true && btnRedo.disabled === false, "after undo: redo enabled");
  t.redo();
  assert(nodeCount() === 6, "redo restores added node");
  assert(state.dirty === true, "redo re-marks unsaved");

  // typing coalescing: rapid edits of the same field merge; a pause splits
  const nid = state.doc.content.nodes[0].id;
  const origTitle = t.getNode(nid).title;
  state.selectedNodeId = nid;
  t.renderInspector();
  const titleInput = getEl("#fTitle");
  titleInput.oninput({ target: { value: "ab" } });
  titleInput.oninput({ target: { value: "abc" } });
  titleInput.oninput({ target: { value: "abcd" } });
  const lenAfterTyping = history.stack.length;
  assert(lenAfterTyping === 3, "rapid typing in one field merges (baseline + add + 1 typing)");
  t.undo();
  assert(t.getNode(nid).title === origTitle, "one undo reverts whole typing burst");
  t.redo();
  // simulate a pause after the burst ended, then type again -> separate item
  history.stack[history.index].time = Date.now() - 5000;
  titleInput.oninput({ target: { value: "abcdX" } });
  assert(history.stack.length === lenAfterTyping + 1, "typing after a pause starts a new item");

  // a different field breaks coalescing
  const before = history.stack.length;
  titleInput.oninput({ target: { value: "abcdXY" } });
  getEl("#fText").oninput({ target: { value: "some text" } });
  assert(history.stack.length === before + 1, "editing a different field is a new item");

  // node drag = exactly one history item, and a no-op drag records nothing
  const dragId = t.getNode(state.doc.content.nodes[2].id).id;
  const dragX = t.getNode(dragId).x;
  const dragY = t.getNode(dragId).y;
  const histBeforeDrag = history.stack.length;
  const wrap = getEl("#canvasWrap");
  const mdFns = wrap.__listeners.mousedown;
  // second wrap mousedown handler is the delegated head/port one
  mdFns[1]({ clientX: 0, clientY: 0, target: { closest: (sel) => (sel === "[data-drag]" ? { dataset: { drag: dragId } } : null) }, preventDefault() {} });
  assert(state.dragNode && state.dragNode.id === dragId, "drag starts on node head");
  docListeners.mousemove({ clientX: 100, clientY: 100 });
  docListeners.mousemove({ clientX: 200, clientY: 220 });
  docListeners.mouseup({ clientX: 200, clientY: 220 });
  assert(history.stack.length === histBeforeDrag + 1, "whole drag = single history item");
  assert(t.getNode(dragId).x === dragX + 200 && t.getNode(dragId).y === dragY + 220, "drag moved node");
  t.undo();
  assert(t.getNode(dragId).x === dragX, "undo restores pre-drag position in one step");
  t.redo();

  // drag ending exactly where it started records no history item
  const histBeforeNoop = history.stack.length;
  mdFns[1]({ clientX: 0, clientY: 0, target: { closest: (sel) => (sel === "[data-drag]" ? { dataset: { drag: dragId } } : null) }, preventDefault() {} });
  docListeners.mousemove({ clientX: 5, clientY: 7 });
  docListeners.mousemove({ clientX: 0, clientY: 0 });
  docListeners.mouseup({ clientX: 0, clientY: 0 });
  assert(history.stack.length === histBeforeNoop, "no-op drag records nothing");

  // connect-drag onto a node = edge add/modify item
  const nid2 = state.doc.content.nodes[0].id;
  const srcNode = t.getNode(nid2);
  const optId = srcNode.options[0].id;
  const oldTarget = srcNode.options[0].target_id;
  const histBeforeConn = history.stack.length;
  documentStub.elementFromPoint = () => ({ closest: (sel) => (sel === ".node" ? { dataset: { id: dragId } } : null) });
  mdFns[1]({
    clientX: 0, clientY: 0,
    target: { closest: (sel) => (sel === ".port" ? { dataset: { node: nid2, opt: optId } } : null) },
    preventDefault() {}, stopPropagation() {},
  });
  docListeners.mouseup({ clientX: 10, clientY: 10 });
  documentStub.elementFromPoint = () => null;
  assert(srcNode.options[0].target_id === dragId, "connection changes option target");
  assert(history.stack.length === histBeforeConn + 1, "connection = single history item");
  t.undo();
  assert(t.getNode(nid2).options[0].target_id === oldTarget, "undo restores previous edge target");
  t.redo();

  // keyboard shortcuts: Ctrl+Z undo, Shift+Ctrl/Cmd+Z redo, Ctrl+Y
  const nodesNow = nodeCount();
  const key = (e) => winListeners.keydown(Object.assign({ preventDefault() {} }, e));
  t.addNode();
  assert(nodeCount() === nodesNow + 1, "setup: node added via toolbar");
  key({ ctrlKey: true, key: "z", shiftKey: false });
  assert(nodeCount() === nodesNow, "Ctrl+Z triggers undo");
  assert(state.dirty === true, "undone-but-not-saved state stays unsaved");
  key({ metaKey: true, key: "z", shiftKey: true });
  assert(nodeCount() === nodesNow + 1, "Shift+Cmd+Z triggers redo");
  key({ ctrlKey: true, key: "Z", shiftKey: false });
  assert(nodeCount() === nodesNow, "Ctrl+Z uppercase Z also works");
  key({ ctrlKey: true, key: "y", shiftKey: false });
  assert(nodeCount() === nodesNow + 1, "Ctrl+Y triggers redo");

  // new edit after undo truncates redo branch
  key({ ctrlKey: true, key: "z", shiftKey: false }); // undo again
  t.addNode();
  assert(btnRedo.disabled === true, "new edit clears redo branch");

  // save clears history and dirty flag
  await t.saveScript();
  assert(state.dirty === false, "saved -> not dirty");
  assert(history.stack.length === 1, "save clears history");
  assert(btnUndo.disabled === true && btnRedo.disabled === true, "buttons disabled after save");

  // switch script clears history (create a 2nd script)
  t.addNode();
  t.addNode();
  assert(history.stack.length === 3, "two edits recorded");
  const res = await fakeFetch("/api/scripts", { method: "POST",
    body: JSON.stringify({ name: "second", content: { start_node_id: null, nodes: [] } }) });
  const created = await res.json();
  await t.openScript(created.id);
  assert(history.stack.length === 1, "switching script clears history");
  assert(state.dirty === false && nodeCount() === 0, "switched to empty script cleanly");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
