import tpl_background_logo from '../../templates/background_logo.js';
import tpl_chats from './templates/chats.js';
import { ElementView } from '@converse/skeletor/src/element.js';
import { api, _converse } from '@converse/headless/core';
import { render } from 'lit-html';


class ConverseChats extends ElementView {

    initialize () {
        this.model = _converse.chatboxes;
        this.listenTo(this.model, 'destroy', this.render);
        this.listenTo(this.model, 'add', this.render);
        this.listenTo(this.model, 'change:hidden', this.render);
        this.listenTo(this.model, 'change:closed', this.render);
        this.listenTo(this.model, 'change:jid', this.render);

        const bg = document.getElementById('conversejs-bg');
        if (bg && !bg.innerHTML.trim()) {
            render(tpl_background_logo(), bg);
        }
        const body = document.querySelector('body');
        body.classList.add(`converse-${api.settings.get('view_mode')}`);
        this.render();

        /**
         * Triggered once the _converse.ChatBoxViews view-colleciton has been initialized
         * @event _converse#chatBoxViewsInitialized
         * @example _converse.api.listen.on('chatBoxViewsInitialized', () => { ... });
         */
        api.trigger('chatBoxViewsInitialized');
    }

    render () {
        render(tpl_chats(), this);
    }

    closeAllChatBoxes () {
        return Promise.all(Array.from(this.children).map(v => v.close({ 'name': 'closeAllChatBoxes' })));
    }
}

api.elements.define('converse-chats', ConverseChats);
