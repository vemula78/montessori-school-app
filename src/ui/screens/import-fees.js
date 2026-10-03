// Route /import/fees - outstanding fees carried over as opening balances (admin, accountant).
import { makeImportScreen } from './import-wizard.js';
export const render = makeImportScreen('fees');
