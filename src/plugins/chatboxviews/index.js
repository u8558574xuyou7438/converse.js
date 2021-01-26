/**
 * @module converse-chatboxviews
 * @copyright 2020, the Converse.js contributors
 * @license Mozilla Public License (MPLv2)
 */
import './view.js';
import '@converse/headless/plugins/chatboxes';
import 'components/converse.js';
import ChatBoxViews from './container.js';
import ViewWithAvatar from 'shared/avatar.js';
import { _converse, api, converse } from '@converse/headless/core';


function calculateViewportHeightUnit () {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
}

converse.plugins.add('converse-chatboxviews', {
    dependencies: ['converse-chatboxes', 'converse-vcard'],

    initialize () {
        /* The initialize function gets called as soon as the plugin is
         * loaded by converse.js's plugin machinery.
         */
        api.elements.register();

        api.promises.add(['chatBoxViewsInitialized']);

        // Configuration values for this plugin
        // ====================================
        // Refer to docs/source/configuration.rst for explanations of these
        // configuration settings.
        api.settings.extend({
            'animate': true,
            'theme': 'default'
        });

        _converse.ViewWithAvatar = ViewWithAvatar;
        _converse.chatboxviews = new ChatBoxViews();

        /************************ BEGIN Event Handlers ************************/
        api.listen.on('chatBoxesInitialized', () => {
            _converse.chatboxes.on('destroy', m => _converse.chatboxviews.remove(m.getAttribute('jid')));
        });

        api.listen.on('cleanup', () => delete _converse.chatboxviews);
        api.listen.on('clearSession', () => _converse.chatboxviews.closeAllChatBoxes());
        api.listen.on('chatBoxViewsInitialized', calculateViewportHeightUnit);

        window.addEventListener('resize', calculateViewportHeightUnit);
        /************************ END Event Handlers ************************/

        Object.assign(converse, {
            /**
             * Public API method which will ensure that the #conversejs element
             * is inserted into a container element.
             *
             * This method is useful when the #conversejs element has been
             * detached from the DOM somehow.
             * @async
             * @memberOf converse
             * @method insertInto
             * @example
             * converse.insertInto(document.querySelector('#converse-container'));
             */
            insertInto (container) {
                const el = _converse.chatboxviews?.el;
                if (el && !container.contains(el)) {
                    container.insertAdjacentElement('afterBegin', el);
                    api.chatviews
                        .get()
                        .filter(v => v.model.get('id') !== 'controlbox')
                        .forEach(v => v.maintainScrollTop());
                } else if (!el) {
                    throw new Error('Cannot insert non-existing #conversejs element into the DOM');
                }
            }
        });
    }
});
