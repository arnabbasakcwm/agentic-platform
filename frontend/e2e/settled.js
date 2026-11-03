// Waits until the page's one-off animations (cards fading in, rows appearing) have
// finished, then returns the page. Accessibility checks measure colour contrast, which a
// half-faded element fails; looping animations (a running glow, a live dot) never finish
// and are left alone.
export async function settled(page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity,
        ),
    null,
    { timeout: 5000 },
  );
  return page;
}
