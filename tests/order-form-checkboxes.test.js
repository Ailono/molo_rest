const fs = require('fs');
const path = require('path');

// Feature: cart-legal-agreements, Task 8.1: Unit test for checkbox rendering in the order form
// Validates: Checkboxes with IDs 'order-offer-accepted' and 'order-pdpa-consent' exist in menu.html

describe('Order form checkbox rendering', () => {
  let menuHtml;

  beforeAll(() => {
    // Read the menu.html file
    const menuHtmlPath = path.join(__dirname, '..', 'public', 'menu.html');
    menuHtml = fs.readFileSync(menuHtmlPath, 'utf8');
  });

  test('The offer checkbox element exists in the DOM', () => {
    // Check for presence of 'order-offer-accepted' ID in the HTML
    const hasOfferCheckbox = menuHtml.includes('id="order-offer-accepted"');
    
    expect(hasOfferCheckbox).toBe(true);
  });

  test('The PDPA consent checkbox element exists in the DOM', () => {
    // Check for presence of 'order-pdpa-consent' ID in the HTML
    const hasPdpaCheckbox = menuHtml.includes('id="order-pdpa-consent"');
    
    expect(hasPdpaCheckbox).toBe(true);
  });

  test('Both checkboxes have correct names for form submission', () => {
    // Check offer_accepted has the correct name attribute
    const hasOfferName = menuHtml.includes('name="offer_accepted"');
    expect(hasOfferName).toBe(true);

    // Check pdpa_consent has the correct name attribute
    const hasPdpaName = menuHtml.includes('name="pdpa_consent"');
    expect(hasPdpaName).toBe(true);
  });

  test('Both checkboxes are properly linked to labels', () => {
    // Check offer checkbox is linked to label
    const hasOfferLabel = menuHtml.includes('for="order-offer-accepted"');
    expect(hasOfferLabel).toBe(true);

    // Check PDPA checkbox is linked to label
    const hasPdpaLabel = menuHtml.includes('for="order-pdpa-consent"');
    expect(hasPdpaLabel).toBe(true);
  });

  // Feature: cart-legal-agreements, Task 8.3: Unit test for target="_blank" attribute on links
  // Validates: Requirements 1.2, 2.2, 6.4
  test('The offer link has target="_blank" attribute', () => {
    // Check that the offer link has target="_blank" to open in a new tab
    const offerLinkRegex = /<a[^>]*href="\/offer\.html"[^>]*target="_blank"[^>]*>/;
    const hasOfferTargetBlank = offerLinkRegex.test(menuHtml);
    
    expect(hasOfferTargetBlank).toBe(true);
  });

  test('The PDPA policy link has target="_blank" attribute', () => {
    // Check that the PDPA policy link has target="_blank" to open in a new tab
    const pdpaLinkRegex = /<a[^>]*href="\/privacy\.html"[^>]*target="_blank"[^>]*>/;
    const hasPdpaTargetBlank = pdpaLinkRegex.test(menuHtml);
    
    expect(hasPdpaTargetBlank).toBe(true);
  });

  // Feature: cart-legal-agreements, Task 8.4: Unit test for checkbox order (offer first, then PDPA)
  // Validates: Requirement 6.1 - чекбоксы согласий должны располагаться в порядке: оферта, затем согласие на ПДн
  test('The offer checkbox appears before the PDPA checkbox in the DOM', () => {
    // Find positions of both checkboxes in the HTML
    const offerPosition = menuHtml.indexOf('id="order-offer-accepted"');
    const pdpaPosition = menuHtml.indexOf('id="order-pdpa-consent"');
    
    // Both checkboxes should exist
    expect(offerPosition).toBeGreaterThan(-1);
    expect(pdpaPosition).toBeGreaterThan(-1);
    
    // Offer checkbox should appear before PDPA checkbox
    expect(offerPosition).toBeLessThan(pdpaPosition);
  });
});