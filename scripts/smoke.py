"""Браузерная проверка страниц в демо-режиме (руки не нужны).

    python3 scripts/smoke.py           # все страницы
    python3 scripts/smoke.py game      # только game.html

Требует Playwright: pip install playwright && playwright install chromium
Скриншоты — в scripts/out/. Код выхода 1, если на странице были ошибки JS.
"""
import asyncio
import pathlib
import sys

try:
    from playwright.async_api import async_playwright
except ImportError:
    print('Playwright не установлен: pip install playwright && playwright install chromium')
    sys.exit(2)

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / 'web'
OUT = ROOT / 'scripts' / 'out'
PAGES = ['index', 'debug', 'game']


async def check(browser, page_name, scheme, width):
    ctx = await browser.new_context(viewport={'width': width, 'height': 900}, color_scheme=scheme)
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto((WEB / f'{page_name}.html').as_uri() + '?demo')
    await pg.evaluate('localStorage.clear()')
    await pg.goto((WEB / f'{page_name}.html').as_uri() + '?demo')
    await pg.wait_for_timeout(800)
    note = ''
    if page_name == 'game' and width > 500:
        # игра только на экране, чтобы не ждать демо-руку
        await pg.click('#physical + .toggle-track')
        await pg.click('.cell[data-i="4"]')
        await pg.wait_for_timeout(1500)
        note = ' · после хода: ' + await pg.inner_text('#turn-title')
    shot = OUT / f'{page_name}-{scheme}-{width}.png'
    await pg.screenshot(path=str(shot), full_page=True)
    await ctx.close()
    status = 'ошибки: ' + '; '.join(errors) if errors else 'ок'
    print(f'{page_name:6} {scheme:5} {width:5}px  {status}{note}')
    return not errors


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pages = [p for p in PAGES if len(sys.argv) < 2 or p in sys.argv[1:]]
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ok = True
        for name in pages:
            for scheme, width in [('light', 1440), ('dark', 1440), ('light', 390)]:
                ok &= await check(browser, name, scheme, width)
        await browser.close()
    print('Скриншоты:', OUT)
    sys.exit(0 if ok else 1)


asyncio.run(main())
