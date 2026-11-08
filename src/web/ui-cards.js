// pi-sec extension cards — the browser half of the named card slots.
//
// An extension may ask for a card in a named slot of this page (`sidebar.bottom`
// today). The server puts that card into the slot as a declarative shadow root:
// a host element, and inside it a `<template shadowrootmode="open">` holding the
// card's style, its body and, when the card has one, its script. A browser that
// ships declarative shadow DOM attaches the root while parsing. One that does
// not leaves the template where it is, and this file attaches it.
//
// Everything the card then does runs through here: a control that changes, a
// press, an event its extension publishes for it alone. A card's script
// therefore never has to know where this page is mounted, how a request is
// built, or which stream the conversation arrives on.
//
// A classic script, like base.js, and for the same reason: both pages load it
// with `<script src>`, and the tests load it the same way (`window.eval`). It
// installs `window.piSecUi`, the way base.js installs `window.piSecMount`:
//
//   window.piSecUi.define("EXT/CARD", function (root, api) { ... })
//   window.piSecUi.dispatch({ extension, card, event, value })
//
// `root` is the card's own shadow root. `api.call(action, value)` posts one
// press to `/api/ui/call` and resolves with the answer's `value`.
// `api.on(event, handler)` hands the handler the event's value and returns the
// function that stops the subscription. `define` works whether it runs before
// or after the card is attached, and one host is mounted once.
(function () {
  /** A card host: which extension drew it, and which card it is. */
  var HOST = ".ui-card[data-ui-card]";
  /** The declarative shadow root the server sends, as an element of the host. */
  var TEMPLATE = "template";
  /** The element that carries the card's markup, and what a call's html replaces. */
  var BODY = "[data-ui-body]";
  /** A control of the card that means something to its extension. */
  var ACTION = "data-action";
  /** The elements whose `change` is a press. Anything else with `data-action`
   *  reports a `click` instead. */
  var CONTROLS = "input, select, textarea";
  /** The one line this page writes into a card whose script did not start. */
  var FAILED = "ui-card-failed";

  /** What each "EXT/CARD" declared to run, by id. */
  var definitions = new Map();
  /** Every host this page attached, oldest first. A page reloads to change its
   *  cards, so this list lives as long as the page does. */
  var attached = [];
  /** The hosts already attached: looking at the page again finds nothing new. */
  var done = new WeakSet();
  /** The hosts whose script already ran, successfully or not. */
  var mounted = new WeakSet();
  /** The event handlers one host subscribed, by event name. */
  var subscriptions = new Map();

  /** The id a card calls itself by: `EXT/CARD`. */
  function idOf(host) {
    var extension = host.getAttribute("data-ui-extension") || "";
    var card = host.getAttribute("data-ui-card") || "";
    return extension === "" ? card : extension + "/" + card;
  }

  function extensionOf(host) {
    return host.getAttribute("data-ui-extension") || "";
  }

  function cardOf(host) {
    return host.getAttribute("data-ui-card") || "";
  }

  /**
   * The call route on this page's mount, by the one rule both pages share (see
   * base.js). A page that arrived without base.js has no rule at all; the root
   * is then the only URL that can be built without a guess.
   */
  function callUrl() {
    var mount = window.piSecMount;
    if (mount === undefined || mount === null || typeof mount.resolve !== "function") return "/api/ui/call";
    return mount.at(mount.resolve(document).base, "/api/ui/call");
  }

  /**
   * One press, on its way to its extension. The body is the shape the route
   * takes and nothing else: the server decides which card may act, and the
   * extension decides what the press means.
   */
  function post(host, action, value) {
    var body = {
      extension: extensionOf(host),
      card: cardOf(host),
      action: action,
      value: value,
    };
    return fetch(callUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = text === "" ? undefined : JSON.parse(text);
        if (!response.ok) {
          var message = data && data.error && data.error.message ? data.error.message : response.statusText;
          var error = new Error(message === undefined || message === "" ? "the ui call failed" : message);
          error.status = response.status;
          error.data = data;
          throw error;
        }
        return data;
      });
    });
  }

  /**
   * The markup an answer carries, into the body of the card that asked. This is
   * the one place the page writes markup it did not build: the server put the
   * html through the card rules (src/server/ui-markup.ts) before sending it.
   */
  function draw(host, data) {
    if (data === undefined || data === null || typeof data.html !== "string") return;
    var root = host.shadowRoot;
    if (root === null) return;
    var body = root.querySelector(BODY);
    if (body === null) return;
    body.innerHTML = data.html;
  }

  /** The card's own call: the answer's value, and its html drawn first. */
  function call(host, action, value) {
    return post(host, action, value).then(function (data) {
      draw(host, data);
      return data === undefined || data === null ? undefined : data.value;
    });
  }

  /**
   * A press the page noticed on the card's behalf. The card's script is not on
   * this stack, so a refusal has nobody to return to: the card's markup stays as
   * it was and the press is spent.
   */
  function send(host, action, value) {
    call(host, action, value).then(undefined, function () {});
  }

  /**
   * The card's script did not start. The page says so in the card's own place:
   * one card that fails must not take the others with it, and a card that drew
   * nothing at all would only look empty.
   */
  function fail(host) {
    var root = host.shadowRoot;
    if (root === null) return;
    if (root.querySelector("." + FAILED) !== null) return;
    var line = document.createElement("div");
    line.className = FAILED;
    // A message, not markup: the id is text here whatever it holds.
    line.textContent = idOf(host) + ": script failed";
    root.appendChild(line);
  }

  /** One subscription, and the function that ends it. */
  function subscribe(host, event, handler) {
    if (typeof handler !== "function") return function () {};
    var name = String(event);
    var byEvent = subscriptions.get(host);
    if (byEvent === undefined) {
      byEvent = new Map();
      subscriptions.set(host, byEvent);
    }
    var handlers = byEvent.get(name);
    if (handlers === undefined) {
      handlers = new Set();
      byEvent.set(name, handlers);
    }
    handlers.add(handler);
    return function off() {
      handlers.delete(handler);
    };
  }

  /** Hand one published event to the handlers of one host. */
  function deliver(host, event, value) {
    var byEvent = subscriptions.get(host);
    if (byEvent === undefined) return;
    var handlers = byEvent.get(event);
    if (handlers === undefined) return;
    // Copied first: a handler that stops its own subscription must not make the
    // next handler on the same event unreachable.
    var list = [];
    handlers.forEach(function (handler) {
      list.push(handler);
    });
    for (var index = 0; index < list.length; index += 1) {
      try {
        list[index](value);
      } catch (error) {
        // One card's handler is not the page's: the others still hear the event.
      }
    }
  }

  /**
   * Run the mount a card declared, once for this host. A throw is drawn as the
   * card's failure line, and the host is not mounted again: its script had its
   * one chance, and a second run would only collect a second failure line.
   */
  function mount(host) {
    if (mounted.has(host)) return;
    var definition = definitions.get(idOf(host));
    if (definition === undefined) return;
    var root = host.shadowRoot;
    if (root === null) return;
    mounted.add(host);
    var api = {
      call: function (action, value) {
        return call(host, action, value);
      },
      on: function (event, handler) {
        return subscribe(host, event, handler);
      },
    };
    var result;
    try {
      result = definition(root, api);
    } catch (error) {
      fail(host);
      return;
    }
    // A mount may be async. A rejection is the same failure as a throw: the card
    // could not start, and saying so is better than an empty card.
    if (result !== null && result !== undefined && typeof result.then === "function") {
      result.then(undefined, function () {
        fail(host);
      });
    }
  }

  /**
   * The press and change delegation, once per shadow root. A card's markup is
   * its extension's, so its controls are answered for what carries `data-action`
   * when the event arrives rather than for what was there when it was wired.
   */
  function wire(host) {
    var root = host.shadowRoot;
    if (root === null) return;

    root.addEventListener("change", function (event) {
      var control = actionTarget(event.target);
      if (control === null || isControl(control) === false) return;
      // A checkbox reports whether it is now on; everything else, what it holds.
      var value = control.type === "checkbox" ? control.checked === true : control.value;
      send(host, control.getAttribute(ACTION), value);
    });

    root.addEventListener("click", function (event) {
      var element = actionTarget(event.target);
      // A control that changes speaks through `change` and its value, so its
      // click is not a second press.
      if (element === null || isControl(element)) return;
      var value = element.getAttribute("value");
      send(host, element.getAttribute(ACTION), value === null ? null : value);
    });
  }

  /** The nearest element carrying `data-action`, or null. */
  function actionTarget(target) {
    if (target === null || target === undefined || typeof target.closest !== "function") return null;
    var element = target.closest("[" + ACTION + "]");
    if (element === null) return null;
    var action = element.getAttribute(ACTION);
    return action === null || action === "" ? null : element;
  }

  function isControl(element) {
    return typeof element.matches === "function" && element.matches(CONTROLS);
  }

  /**
   * Attach one card's shadow root if the browser left that to us, then wire it
   * and mount it. A host the server could not render is a line of text with no
   * template: there is nothing to attach and nothing to mount.
   */
  function attach(host) {
    if (done.has(host)) return;
    if (host.shadowRoot === null || host.shadowRoot === undefined) {
      var template = shadowTemplate(host);
      if (template === null) return;
      var root = host.attachShadow({ mode: "open" });
      root.appendChild(document.importNode(template.content, true));
      template.remove();
    }
    done.add(host);
    attached.push(host);
    wire(host);
    mount(host);
  }

  /** The `template[shadowrootmode]` that is a child of this host, or null. */
  function shadowTemplate(host) {
    for (var index = 0; index < host.children.length; index += 1) {
      var child = host.children[index];
      if (child.localName === TEMPLATE && child.getAttribute("shadowrootmode") !== null) return child;
    }
    return null;
  }

  /** Every card of the page, attached. Safe to run any number of times. */
  function attachAll() {
    var hosts = document.querySelectorAll(HOST);
    for (var index = 0; index < hosts.length; index += 1) attach(hosts[index]);
  }

  /**
   * A card's script says who it is and what to run. Cards of that id already on
   * the page are mounted now; one that arrives later is mounted by `attach`,
   * which runs on every DOMContentLoaded.
   */
  function define(id, run) {
    if (typeof id !== "string" || id === "" || typeof run !== "function") return;
    definitions.set(id, run);
    for (var index = 0; index < attached.length; index += 1) {
      if (idOf(attached[index]) === id) mount(attached[index]);
    }
  }

  /**
   * An event an extension published for its own cards. Two hosts of the same card
   * both hear it; nothing else on the page does, and an event for a card that is
   * not here is dropped.
   */
  function dispatch(payload) {
    if (payload === null || typeof payload !== "object") return;
    var extension = String(payload.extension === null || payload.extension === undefined ? "" : payload.extension);
    var card = String(payload.card === null || payload.card === undefined ? "" : payload.card);
    var event = String(payload.event === null || payload.event === undefined ? "" : payload.event);
    for (var index = 0; index < attached.length; index += 1) {
      var host = attached[index];
      if (extensionOf(host) !== extension || cardOf(host) !== card) continue;
      deliver(host, event, payload.value);
    }
  }

  window.piSecUi = { define: define, dispatch: dispatch };

  // The slot markup is already in the document when this script runs — it sits
  // at the end of the body — but a second pass costs one query and covers a card
  // that arrived with a response after the page was drawn.
  attachAll();
  document.addEventListener("DOMContentLoaded", attachAll);
})();
