import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Focused Playwright a11y helpers. These are not a WCAG program:
 * skip-link activation, heading-vs-background contrast ≥ 4.5, and
 * reduced-motion animation-duration short-circuit only.
 */

export async function headingContrastRatio(heading: Locator): Promise<number> {
  return heading.evaluate((el) => {
    const parse = (value: string): [number, number, number] | null => {
      const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!rgb) {
        return null;
      }
      return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    };
    const channel = (value: number) => {
      const next = value / 255;
      return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb: [number, number, number]) =>
      0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    let color: [number, number, number] | null = null;
    let background: [number, number, number] | null = null;
    let node: HTMLElement | null = el;
    while (node && !color) {
      color = parse(getComputedStyle(node).color);
      node = node.parentElement;
    }
    node = el;
    while (node && !background) {
      const style = getComputedStyle(node);
      const parsed = parse(style.backgroundColor);
      if (parsed && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        background = parsed;
        break;
      }
      node = node.parentElement;
    }
    if (!color || !background) {
      return 0;
    }
    const lighter = Math.max(luminance(color), luminance(background));
    const darker = Math.min(luminance(color), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
  });
}

export async function expectReadableHeading(heading: Locator): Promise<void> {
  await expect(heading).toBeVisible();
  expect(await headingContrastRatio(heading)).toBeGreaterThanOrEqual(4.5);
}

export async function expectReducedMotionDuration(heading: Locator): Promise<void> {
  const seconds = await heading.evaluate((el) => {
    const raw = getComputedStyle(el).animationDuration;
    const first = raw.split(',')[0]?.trim() ?? '0s';
    if (first.endsWith('ms')) {
      return Number.parseFloat(first) / 1000;
    }
    return Number.parseFloat(first);
  });
  expect(seconds).toBeLessThan(0.05);
}

export async function expectSkipToMain(page: Page): Promise<void> {
  const skip = page.getByRole('link', { name: /skip to main content/i });
  await skip.focus();
  await expect(skip).toBeVisible();
  await skip.press('Enter');
  await expect(page).toHaveURL(/#main-content/);
  await expect(page.locator('#main-content')).toBeVisible();
}

export async function expectSkipHref(
  page: Page,
  name: RegExp,
  hash: RegExp,
  target: string,
): Promise<void> {
  const skip = page.getByRole('link', { name });
  await skip.focus();
  await expect(skip).toBeVisible();
  await skip.press('Enter');
  await expect(page).toHaveURL(hash);
  await expect(page.locator(target)).toBeVisible();
}
