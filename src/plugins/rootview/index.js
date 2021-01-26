import { api, converse } from '@converse/headless/core';

const u = converse.env.utils;

function ensureElement () {
    if (!api.settings.get('auto_insert')) {
        return;
    }
    const root = api.settings.get('root');
    if (!root.querySelector('converse-root#conversejs')) {
        const el = document.createElement('converse-root');
        el.setAttribute('id', 'conversejs');
        u.addClass(`theme-${api.settings.get('theme')}`, el);
        const body = root.querySelector('body');
        if (body) {
            body.appendChild(el);
        } else {
            root.appendChild(el); // Perhaps inside a web component?
        }
    }
}

converse.plugins.add('converse-rootview', {
    initialize () {
        api.settings.extend({
            'auto_insert': true
        });

        api.listen.on('chatBoxesInitialized', ensureElement);
    }
});
