addon.name = 'vanahub-test-addon';
addon.author = 'Hildaware';
addon.version = '0.1.0';
addon.desc = 'A minimal addon used to test VanaHub installation.';
addon.link = 'https://github.com/Hildaware/vanahub-test-addon';

require 'common';

local chat = require 'chat';

print(chat.header('VanaHub Test Addon'):append(chat.message('Loaded successfully.')));
