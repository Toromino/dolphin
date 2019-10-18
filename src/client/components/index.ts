import Vue from 'vue';

import mfm from './misskey-flavored-markdown.vue';
import acct from './acct.vue';
import avatar from './avatar.vue';
import emoji from './emoji.vue';
import userName from './user-name.vue';
import followButton from './follow-button.vue';
import ellipsis from './ellipsis.vue';
import time from './time.vue';
import uiContainer from './ui-container.vue';
import uiInput from './ui/input.vue';
import uiButton from './ui/button.vue';

Vue.component('mfm', mfm);
Vue.component('dp-acct', acct);
Vue.component('dp-avatar', avatar);
Vue.component('dp-emoji', emoji);
Vue.component('dp-user-name', userName);
Vue.component('dp-follow-button', followButton);
Vue.component('dp-ellipsis', ellipsis);
Vue.component('dp-time', time);
Vue.component('ui-container', uiContainer);
Vue.component('ui-input', uiInput);
Vue.component('ui-button', uiButton);