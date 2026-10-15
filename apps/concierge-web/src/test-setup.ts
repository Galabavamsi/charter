import { configure } from '@testing-library/react';

// Routes are lazy-loaded chunks. On a busy CI runner the first import can outlast the
// default 1s findBy* wait and leave the test on "Opening Charter…", so allow more time.
configure({ asyncUtilTimeout: 5000 });
