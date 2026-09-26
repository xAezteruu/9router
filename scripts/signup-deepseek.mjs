// DeepSeek signup automation v3
// Handle Aliyun CAPTCHA + Cloudflare Turnstile + email verification

import puppeteer from 'puppeteer';

const CONFIG = {
  HEADLESS: false,
  MAX_WAIT_FOR_EMAIL: 300000,
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Human-like typing with variable delay
async function typeInput(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 10000 });
  const el = await page.$(selector);
  await el.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  for (const c of text) {
    await page.keyboard.type(c, { delay: Math.random() * 80 + 40 });
    await sleep(Math.random() * 30);
  }
}

// Slider move with physics simulation (Aliyun style)
async function moveSlider(session, startX, startY, endX) {
  const dist = Math.abs(endX - startX);
  const n = 42;
  
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX, y: startY });
  await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
  
  const over = dist + 8 + Math.random() * 3;
  
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = 1 - Math.pow(1 - t, 3);
    await session.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: startX + over * ease,
      y: startY + Math.sin(t * 5) * 1.2
    });
    await sleep(11 + (i % 4) * 4);
  }
  
  for (let j = 1; j <= 10; j++) {
    const t = j / 10;
    const cur = over + (dist - over) * t;
    await session.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: startX + cur,
      y: startY + (Math.random() - 0.5) * 1.2
    });
    await sleep(20 + Math.random() * 15);
  }
  
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX + dist, y: startY });
  await sleep(180);
  await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: startX + dist, y: startY, button: 'left', clickCount: 1 });
  await sleep(4000);
}

// Solve Aliyun CAPTCHA
async function solveAliyunCaptcha(page) {
  const frames = page.frames();
  const captchaFrame = frames.find(f => 
    f.url().includes('aliyun') || f.url().includes('captcha')
  );
  
  if (!captchaFrame) return false;
  
  console.log('[*] Aliyun CAPTCHA detected');
  
  const client = await page.target().createCDPSession();
  await client.send('Page.enable');
  await client.send('DOM.enable');
  
  const pos = await captchaFrame.evaluate(() => {
    const el = document.querySelector('.slider') || document.querySelector('[class*="slider"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
  });
  
  if (pos) {
    await moveSlider(client, pos.x, pos.y, pos.x + pos.w);
    return true;
  }
  
  return false;
}

// Solve Cloudflare Turnstile
async function solveCloudflareCaptcha(page) {
  const frames = page.frames();
  const cfFrame = frames.find(f => 
    f.url().includes('challenges') || f.url().includes('cloudflare')
  );
  
  if (!cfFrame) return false;
  
  console.log('[*] Cloudflare CAPTCHA detected');
  
  try {
    const checkboxes = await cfFrame.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const box = await cb.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
        await sleep(2000);
      }
    }
    return true;
  } catch { return false; }
}

// Wait for email and extract verification code
async function waitForEmail(email) {
  console.log(`[*] Check email: ${email}`);
  console.log('[*] Look for verification code in inbox (check manually)');
  return new Promise(resolve => {
    setTimeout(() => {
      const code = prompt(`Enter verification code from ${email}:`);
      resolve(code);
    }, 1000);
  });
}

export async function deepseekSignup(email, password) {
  const browser = await puppeteer.launch({
    headless: CONFIG.HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    ]
  });
  
  try {
    const page = await browser.newPage();
    
    // Bypass automation detection
    await page.evaluateOnNewDocument(() => {
      delete navigator.__proto__.webdriver;
      navigator.languages = ['en-US', 'en'];
    });
    
    console.log('[*] Opening DeepSeek signup...');
    await page.goto('https://chat.deepseek.com/sign_up', { 
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    await sleep(2000);
    
    // Fill signup form
    console.log('[*] Filling form...');
    await typeInput(page, 'input[type="email"]', email);
    await sleep(300);
    await typeInput(page, 'input[type="password"]', password);
    await sleep(300);
    
    // Submit
    await page.click('button[type="submit"]');
    await sleep(3000);
    
    // Check for CAPTCHA
    if (await solveAliyunCaptcha(page)) {
      console.log('[+] Aliyun CAPTCHA solved');
    } else if (await solveCloudflareCaptcha(page)) {
      console.log('[+] Cloudflare CAPTCHA solved');
    }
    
    // Wait for email verification
    console.log('[*] Waiting for email verification...');
    const code = await waitForEmail(email);
    
    // Input verification code
    const codeInput = await page.$('input[type="text"], input[name="code"], input[name="verification_code"]');
    if (codeInput) {
      for (const c of code) {
        await codeInput.type(c, { delay: 100 });
        await sleep(50);
      }
      await page.click('button[type="submit"]');
      console.log('[+] Verification submitted');
    }
    
    await sleep(5000);
    console.log('[*] Final URL:', page.url());
    console.log('[*] Browser will remain open 30s...');
    await sleep(30000);
    
  } finally {
    await browser.close();
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2];
  const password = process.argv[3];
  
  if (!email || !password) {
    console.error('Usage: node signup-deepseek.mjs <email> <password>');
    process.exit(1);
  }
  
  deepseekSignup(email, password).catch(console.error);
}
