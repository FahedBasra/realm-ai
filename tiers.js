/* EDIT THIS FILE to change plans. Price IDs come from Paddle Sandbox > Catalog > Products (pri_...).
 * interface Tier { name:'Starter'|'Pro'|'Advanced'; description:string; features:string[];
 *                  priceId:{month:string; year:string}; highlight?:boolean } */
window.REALM_TIERS = [
  { name: 'Starter', description: 'For everyday AI help.',
    features: ['Everyday AI chat', 'Higher daily limits', 'Text file analysis', 'Image generator', 'Saved chat history'],
    priceId: { month: 'pri_REPLACE_ME', year: 'pri_REPLACE_ME' } },
  { name: 'Pro', description: 'For power users and builders.', highlight: true,
    features: ['Everything in Starter', 'Much higher usage', 'AI Agent mode', 'Code Assistant', 'Faster responses'],
    priceId: { month: 'pri_REPLACE_ME', year: 'pri_REPLACE_ME' } },
  { name: 'Advanced', description: 'For heavy, advanced workflows.',
    features: ['Everything in Pro', 'Highest usage limits', 'Advanced agent workflows', 'Early access to new features', 'Priority support'],
    priceId: { month: 'pri_REPLACE_ME', year: 'pri_REPLACE_ME' } }
];
