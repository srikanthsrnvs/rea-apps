export const scenarios = {
  latte: {
    prompts: [
      "From Harbor Kitchen, add two large 16 oz lattes with oat milk, no foam and two extra espresso shots per drink for pickup. Use the area around 100 Test Avenue. Don't order.",
      'Actually make those three lattes total. Keep everything else the same.',
    ],
    expected: 'latte',
  },
  mixed: {
    prompts: [
      "From Harbor Kitchen, get one Garden Burger with no onions and sauce on the side, plus two Fries with no salt, delivered to Home at 100 Test Avenue. Prepare checkout with a $2.50 tip for review. Don't buy.",
      'Remove just the burger and keep the fries. Do not buy.',
    ],
    expected: 'mixed',
  },
  unavailable: {
    prompts: [
      "Add one Latte from Harbor Kitchen with Oat Milk for delivery to Home. Oat milk is required; if it is sold out, stop without substitutions or cart changes. Don't buy.",
    ],
    unavailableOat: true,
    expected: 'unavailable',
  },
  unknown: {
    prompts: [
      "Add one regular Berry Banana Smoothie from Harbor Kitchen for delivery to Home at 100 Test Avenue. If any addition has an unknown outcome, inspect the same operation and stop rather than retrying or starting over. Don't order.",
    ],
    unknownCreate: true,
    expected: 'unknown',
  },
};
