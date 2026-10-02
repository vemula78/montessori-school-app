// Obviously-fake naming for the demo data. The seed scan fails any surname outside FAKE_SURNAMES.

export const FAKE_SURNAMES = [
  'Demoson', 'Sampleraj', 'Testwala', 'Mockherjee', 'Placeholdar', 'Specimenova',
  'Dummyan', 'Fakeswaran', 'Exampleton', 'Samplekar', 'Trialsen', 'Mockrishnan',
  'Fictionwala', 'Notrealsen', 'Pretendkar', 'Stubbington',
];

export const SCHOOL = {
  name: 'Little Acorns Montessori (Demo)',
  address: '14 Acorn Lane, Maple Grove Layout, Bengaluru 560000 (fictional address)',
  phone: '+91-90000-00001',
};

// Fictional locality used for bus routes; coordinates are plausible for Bengaluru, the places are invented.
export const LOCALITY = {
  name: 'Maple Grove Layout (fictional)',
  school: { lat: 12.9063, lng: 77.5857 },
};

export const fakePhone = (n) => `+91-90000-00${String(n).padStart(3, '0')}`;
export const fakeEmail = (first, last, n = '') => `${first}.${last}${n}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + '@example.com';
