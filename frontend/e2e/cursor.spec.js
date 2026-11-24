import { expect, test } from "@playwright/test";

// The pointer must always stay a system cursor with its normal outline: no custom cursor
// images, nothing hiding it, and nothing blending or filtering the pixels it passes over.
// Rather than hover a few spots, every element of every page is checked through its
// computed style, which is exactly what decides the pointer shown over it.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";

test.beforeEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

// The admin check switches the mock to an admin user: leave it as found.
test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

const INTERACTIVE =
  'a[href], button, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], summary, select, input[type="checkbox"], input[type="radio"], input[type="file"], input[type="submit"]';
const TEXT_FIELD =
  'input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="number"], input[type="url"], textarea, [contenteditable="true"]';

/** Everything wrong with how the pointer behaves on the page as currently shown. */
async function cursorProblems(page) {
  return page.evaluate(
    ({ INTERACTIVE, TEXT_FIELD }) => {
      const problems = [];
      const name = (el) =>
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const inert = (el) =>
        el.disabled || el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-busy") === "true";
      const interactiveEls = [...document.querySelectorAll(INTERACTIVE)].filter(visible);

      for (const el of document.querySelectorAll("body, body *")) {
        const s = getComputedStyle(el);
        // System cursors only: no image, and never hidden.
        if (s.cursor.includes("url(")) problems.push(`${name(el)}: custom cursor image (${s.cursor})`);
        if (s.cursor === "none") problems.push(`${name(el)}: cursor: none`);
        // Nothing may blend with what is behind it.
        if (s.mixBlendMode !== "normal") problems.push(`${name(el)}: mix-blend-mode ${s.mixBlendMode}`);
        if (s.backgroundBlendMode.split(",").some((m) => m.trim() !== "normal"))
          problems.push(`${name(el)}: background-blend-mode ${s.backgroundBlendMode}`);
        // A filter on something the pointer passes over (anything holding a control).
        const filtered = s.filter !== "none" || (s.backdropFilter && s.backdropFilter !== "none");
        if (filtered && el.matches(INTERACTIVE) === false && el.querySelector(INTERACTIVE) && visible(el))
          problems.push(`${name(el)}: filter/backdrop-filter over controls`);
      }

      for (const el of interactiveEls) {
        const s = getComputedStyle(el);
        // Visually hidden controls (a custom checkbox's real input) show no pointer at all.
        if (el.closest(".sr-only") || s.opacity === "0") continue;
        const cursor = s.cursor;
        if (inert(el)) {
          if (!["not-allowed", "default", "progress", "wait"].includes(cursor))
            problems.push(`${name(el)}: disabled but cursor ${cursor}`);
        } else if (el.closest(".react-flow__controls") || el.matches("input[type=file]")) {
          // Library-drawn or hidden file inputs: any system cursor.
        } else if (cursor !== "pointer") {
          problems.push(`${name(el)}: clickable but cursor ${cursor}`);
        }
        // Nothing may sit on top of a control (a decorative layer that would take the pointer).
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const x = Math.min(Math.max(r.x + r.width / 2, 1), innerWidth - 1);
        const y = Math.min(Math.max(r.y + r.height / 2, 1), innerHeight - 1);
        const top = document.elementFromPoint(x, y);
        if (top && !(el.contains(top) || top.contains(el) || top.closest("label") === el.closest("label")) && !top.closest("[role=dialog], [role=listbox], [role=menu], .popover, .overlay")) {
          problems.push(`${name(el)}: covered by ${name(top)}`);
        }
      }

      // Everything that isn't a control or a text field shows the plain arrow, including
      // over text: `auto` would turn into the thin I-beam (no outline) over any text.
      for (const el of document.querySelectorAll("body *")) {
        if (!visible(el) || el.closest(`${INTERACTIVE}, ${TEXT_FIELD}, .react-flow__pane, .react-flow__controls, svg, [class*=resize]`)) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const cursor = getComputedStyle(el).cursor;
        if (!["default", "pointer", "not-allowed", "progress", "help", "wait", "col-resize"].includes(cursor))
          problems.push(`${name(el)}: text shows the "${cursor}" cursor (I-beam), not the arrow`);
      }

      for (const el of document.querySelectorAll(TEXT_FIELD)) {
        if (!visible(el) || el.disabled || el.readOnly) continue;
        const s = getComputedStyle(el);
        // The I-beam has no outline (it vanished over the sign-in email field): the arrow.
        if (s.cursor !== "default") problems.push(`${name(el)}: text field but cursor ${s.cursor}`);
        // The caret must be visible: not transparent, and not the same colour as the field.
        const caret = s.caretColor;
        if (caret === "rgba(0, 0, 0, 0)" || caret === "transparent")
          problems.push(`${name(el)}: invisible caret`);
        if (caret !== "auto" && caret === s.backgroundColor) problems.push(`${name(el)}: caret matches its background`);
      }
      return [...new Set(problems)];
    },
    { INTERACTIVE, TEXT_FIELD },
  );
}

async function visit(page, hash, ready) {
  await page.goto(`/${hash}`);
  if (ready) await expect(page.locator(ready).first()).toBeVisible();
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
}

for (const scheme of ["light", "dark"]) {
  test.describe(`cursor, ${scheme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
    });

    test("sign-in", async ({ page }) => {
      await visit(page, "#/", ".authintro, form");
      expect(await cursorProblems(page)).toEqual([]);
    });

    test.describe("signed in", () => {
      test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
          sessionStorage.setItem("agentic-platform.token", "e2e-token");
          localStorage.setItem("agentic-platform.assistant-open", "0");
        });
      });

      test("new project, with each popover open", async ({ page }) => {
        await visit(page, "#/", "form");
        expect(await cursorProblems(page), "closed").toEqual([]);
        const form = page.locator("form").first();
        for (const name of [/Add context/, /^Model/, /^Team/, /^Tools/]) {
          await form.getByRole("button", { name }).click();
          expect(await cursorProblems(page), `popover ${name}`).toEqual([]);
          await page.keyboard.press("Escape");
        }
      });

      for (const [label, hash, ready] of [
        ["projects", "#/projects", ".table"],
        ["brief", `#/projects/${PROJECT}/brief`, ".projhead"],
        ["resources", `#/projects/${PROJECT}/resources`, ".projhead"],
        ["plan", `#/projects/${PROJECT}/plan`, ".projhead"],
        ["compile", `#/projects/${PROJECT}/compile`, ".projhead"],
        ["run", `#/projects/${PROJECT}/run`, ".diagram .react-flow__node"],
        ["deploy", `#/projects/${PROJECT}/deploy`, ".projhead"],
        ["usage", "#/usage", ".sidebar"],
        ["knowledge", "#/knowledge", ".sidebar"],
        ["data sources", "#/data", ".sidebar"],
        ["mcp servers", "#/mcp", ".sidebar"],
      ]) {
        test(label, async ({ page }) => {
          await visit(page, hash, ready);
          // The sidebar and top bar are on every page; they're checked with each.
          expect(await cursorProblems(page)).toEqual([]);
        });
      }

      test("run page: pane, nodes, edges and controls", async ({ page }) => {
        await visit(page, `#/projects/${PROJECT}/run`, ".diagram .react-flow__node");
        const cursors = await page.evaluate(() => {
          const c = (sel) => {
            const el = document.querySelector(sel);
            return el ? getComputedStyle(el).cursor : "missing";
          };
          return {
            pane: c(".diagram .react-flow__pane"),
            node: c(".diagram .flow-node"),
            terminal: c(".diagram .flow-terminal"),
            edge: c(".diagram .react-flow__edge-path"),
            controls: c(".diagram .react-flow__controls-button"),
          };
        });
        expect(cursors.pane).toBe("default"); // the hand cursors showed no outline on the dotted background
        expect(cursors.node).toBe("pointer"); // a node opens its output
        expect(["default", "auto"]).toContain(cursors.terminal);
        expect(["default", "auto", "pointer"]).toContain(cursors.edge);
        expect(cursors.controls).toBe("pointer");
        // Dragging the pane to pan keeps the arrow.
        const box = await page.locator(".diagram .react-flow__pane").boundingBox();
        await page.mouse.move(box.x + 40, box.y + 40);
        await page.mouse.down();
        await page.mouse.move(box.x + 80, box.y + 60);
        expect(await page.locator(".diagram .react-flow__pane").evaluate((el) => getComputedStyle(el).cursor)).toBe("default");
        await page.mouse.up();
      });
    });
  });
}

test("admin page", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await request.post(`${API}/__as_admin`);
  await visit(page, "#/admin", ".admin__table");
  expect(await cursorProblems(page)).toEqual([]);
});
