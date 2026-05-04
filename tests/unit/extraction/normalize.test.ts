import { describe, expect, it } from 'vitest';
import { normalizeEntityName } from '../../../src/extraction/normalize.js';

describe('normalizeEntityName', () => {
  describe('Organization', () => {
    it('strips common suffixes (Inc, Corp, Corporation, Ltd, LLC, GmbH)', () => {
      expect(normalizeEntityName('Microsoft Corp.', 'Organization')).toBe('microsoft');
      expect(normalizeEntityName('Microsoft Corporation', 'Organization')).toBe('microsoft');
      expect(normalizeEntityName('Microsoft Inc.', 'Organization')).toBe('microsoft');
      expect(normalizeEntityName('Apple Inc', 'Organization')).toBe('apple');
      expect(normalizeEntityName('Acme Ltd.', 'Organization')).toBe('acme');
      expect(normalizeEntityName('Acme LLC', 'Organization')).toBe('acme');
      expect(normalizeEntityName('Acme GmbH', 'Organization')).toBe('acme');
    });

    it('collapses repeated whitespace', () => {
      expect(normalizeEntityName('Microsoft  Corp', 'Organization')).toBe('microsoft');
    });

    it('does not collapse hyphenated names within the core', () => {
      expect(normalizeEntityName('Hewlett-Packard Inc.', 'Organization')).toBe('hewlett-packard');
    });
  });

  describe('Person', () => {
    it('strips honorifics', () => {
      expect(normalizeEntityName('Dr. Jane Wilson', 'Person')).toBe('jane wilson');
      expect(normalizeEntityName('Mr. John Smith', 'Person')).toBe('john smith');
      expect(normalizeEntityName('Professor Albus Dumbledore', 'Person')).toBe(
        'albus dumbledore'
      );
    });

    it('strips trailing credentials', () => {
      expect(normalizeEntityName('Jane Wilson, PhD', 'Person')).toBe('jane wilson');
      expect(normalizeEntityName('John Smith, Esq.', 'Person')).toBe('john smith');
      expect(normalizeEntityName('Bob Jr.', 'Person')).toBe('bob');
    });
  });

  describe('Date', () => {
    it('parses common dates to ISO', () => {
      expect(normalizeEntityName('March 15, 2023', 'Date')).toBe('2023-03-15');
    });

    it('falls back to lowercase whitespace-collapsed for un-parseable dates', () => {
      expect(normalizeEntityName('Q3 2024', 'Date')).toBe('q3 2024');
    });
  });

  it('removes diacritics', () => {
    expect(normalizeEntityName('Café', 'Organization')).toBe('cafe');
    expect(normalizeEntityName('Zoë', 'Person')).toBe('zoe');
  });

  it('handles empty / single-character inputs', () => {
    expect(normalizeEntityName('', 'Person')).toBe('');
    expect(normalizeEntityName('  ', 'Person')).toBe('');
    expect(normalizeEntityName('A', 'Person')).toBe('a');
  });

  it('handles mixed scripts gracefully', () => {
    // Cyrillic + Latin should not throw
    expect(normalizeEntityName('Москва Bank', 'Organization')).toContain('bank');
  });
});
