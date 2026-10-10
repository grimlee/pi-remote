import assert from 'node:assert/strict';

// Deliberately failed modules and lifecycle events during a slow WASM load.
// These simulate browser timing; they do not substitute for physical iOS tests.
export async function verifyStartup(browser, origin) {
  const failed = await browser.newContext({viewport:{width:390,height:844}});
  try {
    await failed.route('**/app.js', route => route.abort());
    const page = await failed.newPage();
    await page.goto(origin);
    await page.locator('#loginView').waitFor({state:'visible'});
    await page.waitForFunction(() => document.getElementById('tailcatStartup').textContent.includes('界面资源加载失败'));
    assert.equal(await page.locator('#loginForm button').isDisabled(), true);
    assert.equal(await page.locator('a[href="/recover.html"]').isVisible(), true);
  } finally { await failed.close(); }

  const delayed = await browser.newContext({viewport:{width:390,height:844}});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await delayed.route('**/main.wasm.gz', async route => { await gate; await route.continue(); });
    const page = await delayed.newPage();
    await page.goto(origin);
    await page.locator('#loginView').waitFor({state:'visible'});
    await page.waitForFunction(() => !!window.piRemoteTransport);
    assert.equal(await page.locator('#loginForm button').isDisabled(), true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true,get:()=>window.simulatedHidden});
      for (const hidden of [true, false, true]) { window.simulatedHidden = hidden; document.dispatchEvent(new Event('visibilitychange')); }
    });
    release();
    await page.waitForFunction(() => window.piRemoteTransport.diagnostics().wasmStartupMs !== null, null, {timeout:60000});
    assert.equal(await page.evaluate(() => window.piRemoteTransport.diagnostics().state), 'background');
    await page.evaluate(() => { window.simulatedHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.piRemoteTransport.diagnostics().state === 'unpaired' && !document.getElementById('loginView').hidden);
    assert.equal(await page.locator('#loginForm button').isEnabled(), true);
    // Safari may deliver pageshow/focus without another visibility event.
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true})); window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => window.piRemoteTransport.diagnostics().state === 'unpaired');
  } finally { release(); await delayed.close(); }
}
