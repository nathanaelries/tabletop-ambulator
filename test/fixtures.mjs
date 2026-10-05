export const HOST_KEY = 'test-host-key-0123456789abcdef0123456789abcdef';
export const snapshot = () => ({
  hands: {
    Red: [{ index: 1, cards: [{ guid: 'a00001', name: 'Red train', face: 'https://i.imgur.com/train.png', columns: 2, rows: 2, offset: 0 }] }, { index: 2, cards: [{ guid: 'a00002', name: 'Red destination', face: 'https://i.imgur.com/tickets.png', columns: 2, rows: 2, offset: 1 }] }],
    Blue: [{ index: 1, cards: [{ guid: 'b00001', name: 'Blue train' }] }, { index: 2, cards: [{ guid: 'b00002', name: 'Blue destination' }] }]
  },
  decks: [{ guid: 'd00001', name: 'Train deck' }, { guid: 'd00002', name: 'Destination deck' }], acks: []
});

export const controlSnapshot = () => {
  const state = snapshot();
  state.hands.Red[0].cards.push({ guid: 'a00003', name: 'Second Red train' });
  state.targets = [{ id: 'global:1', label: 'Ticket returns', signature: 'target-v1', colors: ['Red'] }];
  state.buttons = [{ id: 'e00001:0', label: 'Draw tickets', signature: 'button-v1', colors: ['Red'], ready: true },
    { id: 'e00002:0', label: 'No adapter', signature: 'button-unready', colors: [], ready: false }];
  return state;
};
