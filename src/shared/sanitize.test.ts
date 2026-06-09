import { describe, it, expect } from 'vitest';
import { sanitizeText, isValidTaskText } from '../../shared/sanitize';

describe('sanitizeText', () => {
  it('removes HTML tags', () => {
    expect(sanitizeText('<b>bold</b>')).toBe('bold');
    expect(sanitizeText('<script>alert("xss")</script>')).toBe('alert("xss")');
    expect(sanitizeText('Hello <img src="x" onerror="alert(1)"> World')).toBe('Hello World');
  });

  it('preserves HTML entities (no decoding to prevent XSS)', () => {
    expect(sanitizeText('&amp;')).toBe('&amp;');
    expect(sanitizeText('&lt;')).toBe('&lt;');
    expect(sanitizeText('&gt;')).toBe('&gt;');
    expect(sanitizeText('&quot;')).toBe('&quot;');
    expect(sanitizeText('&#x27;')).toBe('&#x27;');
    expect(sanitizeText('&#x2F;')).toBe('&#x2F;');
  });

  it('trims and normalizes whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
    expect(sanitizeText('hello   world')).toBe('hello world');
    expect(sanitizeText('  hello   world  ')).toBe('hello world');
    expect(sanitizeText('\thello\n\nworld\t')).toBe('hello world');
  });

  it('truncates to max length', () => {
    const longText = 'a'.repeat(600);
    expect(sanitizeText(longText).length).toBe(500);
  });

  it('handles empty string', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('handles string with only whitespace', () => {
    expect(sanitizeText('   ')).toBe('');
  });

  it('handles string with only HTML tags', () => {
    expect(sanitizeText('<br><hr><div></div>')).toBe('');
  });

  it('handles nested HTML tags', () => {
    expect(sanitizeText('<div><span>text</span></div>')).toBe('text');
  });

  it('removes a trailing unclosed HTML tag', () => {
    expect(sanitizeText('hello <scr')).toBe('hello');
    expect(sanitizeText('hello <')).toBe('hello');
    expect(sanitizeText('<b>bold</b> trailing <i')).toBe('bold trailing');
    expect(sanitizeText('<')).toBe('');
  });

  it('strips Unicode control characters (Cc)', () => {
    expect(sanitizeText('he\u0000llo')).toBe('hello');
    expect(sanitizeText('bell\u0007 sound')).toBe('bell sound');
    expect(sanitizeText('del\u007Fete')).toBe('delete');
    expect(sanitizeText('esc\u001Bape')).toBe('escape');
  });

  it('strips Unicode format characters (Cf)', () => {
    expect(sanitizeText('zero\u200Bwidth')).toBe('zerowidth');
    expect(sanitizeText('rtl\u202Eoverride')).toBe('rtloverride');
    expect(sanitizeText('bom\uFEFFmarker')).toBe('bommarker');
    expect(sanitizeText('soft\u00ADhyphen')).toBe('softhyphen');
  });

  it('keeps useful whitespace when stripping control characters', () => {
    expect(sanitizeText('tab\there')).toBe('tab here');
    expect(sanitizeText('line\nbreak')).toBe('line break');
    expect(sanitizeText('carriage\rreturn')).toBe('carriage return');
  });
});

describe('isValidTaskText', () => {
  it('returns true for valid text', () => {
    expect(isValidTaskText('Buy groceries')).toBe(true);
    expect(isValidTaskText('a')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isValidTaskText('')).toBe(false);
  });

  it('returns false for whitespace-only after sanitization', () => {
    expect(isValidTaskText(sanitizeText('   '))).toBe(false);
  });

  it('returns false for HTML-only after sanitization', () => {
    expect(isValidTaskText(sanitizeText('<br>'))).toBe(false);
  });

  it('returns true for text at max length', () => {
    expect(isValidTaskText('a'.repeat(500))).toBe(true);
  });

  it('returns false for text over max length', () => {
    expect(isValidTaskText('a'.repeat(600))).toBe(false);
  });

  it('returns true for over-length text after sanitization (truncated to 500)', () => {
    expect(isValidTaskText(sanitizeText('a'.repeat(600)))).toBe(true);
  });
});
