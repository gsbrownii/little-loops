// The 12-colour paint palette (order = rainbow, then browns/skin, then white).
// `name` is spoken when the swatch is tapped. White works as the eraser.
export const WHITE = '#FFFFFF';

export const PALETTE = [
  { id: 'red', name: 'Red', hex: '#FF4D4D' },
  { id: 'orange', name: 'Orange', hex: '#FF9F1C' },
  { id: 'yellow', name: 'Yellow', hex: '#FFE14D' },
  { id: 'light-green', name: 'Light green', hex: '#9BE564' },
  { id: 'green', name: 'Green', hex: '#2DBE60' },
  { id: 'light-blue', name: 'Light blue', hex: '#7FD8FF' },
  { id: 'blue', name: 'Blue', hex: '#3A7BFF' },
  { id: 'purple', name: 'Purple', hex: '#9B5DE5' },
  { id: 'pink', name: 'Pink', hex: '#FF8FC8' },
  { id: 'brown', name: 'Brown', hex: '#A0673C' },
  { id: 'peach', name: 'Peach', hex: '#FFCFA8' },
  { id: 'white', name: 'White', hex: WHITE, eraser: true },
];
