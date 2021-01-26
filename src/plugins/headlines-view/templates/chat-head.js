import { _converse } from '@converse/headless/core';
import { html } from "lit-html";
import { until } from 'lit-html/directives/until.js';


export default (o) => {
    const tpl_standalone_btns = (o) => o.standalone_btns.reverse().map(b => until(b, ''));
    return html`
        <div class="chatbox-title ${ o.status ? '' :  "chatbox-title--no-desc"}">
            <div class="chatbox-title--row">
                ${ (!_converse.api.settings.get("singleton")) ? html`<div class="chatbox-navback"><i class="fa fa-arrow-left"></i></div>` : '' }
                <div class="chatbox-title__text" title="${o.jid}">${ o.display_name }</div>
            </div>
            <div class="chatbox-title__buttons row no-gutters">
                ${ o.dropdown_btns.length ? html`<converse-dropdown .items=${o.dropdown_btns}></converse-dropdown>` : '' }
                ${ o.standalone_btns.length ? tpl_standalone_btns(o) : '' }
            </div>
        </div>
        ${ o.status ? html`<p class="chat-head__desc">${ o.status }</p>` : '' }
    `;
}
