import { html } from 'lit-html';

export default (o) => html`
    <div class="flyout box-flyout">
        <div class="chat-head controlbox-head">
            ${o.sticky_controlbox ? '' : html`<a class="chatbox-btn close-chatbox-button fa fa-times"></a>` }
        </div>
        <div class="controlbox-panes">
            <converse-headlines-panel></converse-headlines-panel>
            <converse-rooms-list></converse-rooms-list>
        </div>
    </div>
`;
