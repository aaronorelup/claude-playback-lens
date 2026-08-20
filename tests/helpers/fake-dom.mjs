// tests/helpers/fake-dom.mjs — the shared dependency-free fake DOM.
//
// No JSDOM (no dependencies allowed). This ~120-line fake document is enough
// to prove the BUILD-CONTRACTS mount signature holds for every component:
//
//     mount(el, props) -> { update(props), destroy() }
//
// and that each one paints the class names the styling groups depend on.
//
// History: this stub was re-declared nearly verbatim in nine web test files
// (web-dom-smoke, web-fixes-round1/5/7/8/11/12/13/14). This module is the
// UNION of every copy, so no file loses a capability by importing it:
//   - append(...nodes)            (all copies except web-dom-smoke)
//   - remove()                    (rounds 5, 7, 8)
//   - element.style = {}          (rounds 5, 7, 8)
//   - element.dataset = {}        (round 14)
//   - dispatch() synthesizing currentTarget/target/preventDefault/
//     stopPropagation             (all copies except web-dom-smoke, whose
//                                  dispatch passed the bare event object)
// Round 8's copy was a reduced subset (no-op removeEventListener, no
// selector engine); the full versions here are strictly more capable.
//
// Usage: each test file imports { doc } and installs it itself —
//
//     globalThis.document = doc;
//
// BEFORE dynamically importing any web module, keeping the "imports happen
// after the fake document exists" ordering each file proves explicit.

export class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; this.nodeType = 1; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  appendChild(node) {
    if (node instanceof FakeFragment) {
      for (const c of node.childNodes.slice()) this.appendChild(c);
      node.childNodes.length = 0;
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) { for (const n of nodes) if (n) this.appendChild(n); }
  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (i === -1) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

export class FakeFragment extends FakeNode { constructor() { super(); this.nodeType = 11; } }

export class FakeText extends FakeNode {
  constructor(data) { super(); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
}

export class FakeElement extends FakeNode {
  constructor(tag, ns) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag);
    this.namespaceURI = ns || null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.ownerDocument = doc;
    this.clientWidth = 0;
    this.style = {};
    this.dataset = {};
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((f) => f !== fn));
  }
  dispatch(type, ev = {}) { for (const fn of this.listeners.get(type) || []) fn({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...ev }); }
  get classList() {
    const el = this;
    const read = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    return {
      add: (c) => { const s = new Set(read()); s.add(c); el.setAttribute('class', [...s].join(' ')); },
      remove: (c) => { const s = new Set(read()); s.delete(c); el.setAttribute('class', [...s].join(' ')); },
      contains: (c) => read().includes(c),
    };
  }
  get textContent() { return this.childNodes.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this.childNodes.length = 0; this.appendChild(new FakeText(v)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 200 }; }
  // Minimal selector support: tag, .class, [attr]
  querySelectorAll(sel) {
    const out = [];
    const want = String(sel).split(',').map((s) => s.trim());
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) { if (want.some((w) => matchesSimple(c, w))) out.push(c); walk(c); }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return String(sel).split(',').some((w) => matchesSimple(this, w.trim())); }
  scrollIntoView() {}
  focus() {}
}

export function matchesSimple(el, sel) {
  if (!sel) return false;
  const cls = sel.match(/\.([A-Za-z0-9_-]+)/g) || [];
  const attrs = sel.match(/\[[^\]]+\]/g) || [];
  const tag = (sel.match(/^[a-zA-Z][a-zA-Z0-9]*/) || [null])[0];
  if (tag && el.localName !== tag) return false;
  for (const c of cls) if (!el.classList.contains(c.slice(1))) return false;
  for (const a of attrs) {
    const inner = a.slice(1, -1);
    const eq = inner.indexOf('=');
    if (eq === -1) { if (!el.hasAttribute(inner)) return false; }
    else if (el.getAttribute(inner.slice(0, eq)) !== inner.slice(eq + 1).replace(/^["']|["']$/g, '')) return false;
  }
  return true;
}

export const doc = {
  createElement: (t) => new FakeElement(t, null),
  createElementNS: (ns, t) => new FakeElement(t, ns),
  createTextNode: (d) => new FakeText(d),
  createDocumentFragment: () => new FakeFragment(),
  title: '',
  getElementById: () => null,
};
