

define('VesselPlotting',
[
    'UWA/Core',
    'UWA/Promise',
    'UWA/String',
    'DS/WAFData/WAFData',
    'DS/PlatformAPI/PlatformAPI',
    'DS/UIKIT/Toggler',
    'DS/UIKIT/Autocomplete',
    'DS/UIKIT/Input/Button',
    'DS/UIKIT/Scroller',
    'css!DS/UIKIT/UIKIT.css'
],

function (UWA, Promise, String, WAFData, PlatformAPI) {

'use strict';

    function buildHtml() {
        var html = 'Hello';

        return html;
    }

    function initUi() {
        widget.body.empty();
        UWA.createElement('div', { html: buildHtml() }).inject(widget.body);
    }


 

    // ---------------------------------------------------------------------
    // LOAD
    // ---------------------------------------------------------------------
    function onLoad() {
        initUi();
    }

    widget.addEvent('onLoad', onLoad);
    return app;
});
