import { createServer } from 'node:http';
import { handler } from './backend.js';

const port=Number(process.env.PORT || 3000);
createServer(handler).listen(port, '0.0.0.0', () => console.log(`Word-Thing Cloud: http://localhost:${port}`));
