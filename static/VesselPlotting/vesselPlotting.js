

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
		
		var vesselPayload = {
                action: 'ADD_3D_PRIMITIVE',
                type: 'Vessel',
                coordinates: {
                    lat: 12.9716,
                    lng: 77.5946,
                    alt: 0.0
                },
                orientation: {
                    heading: 45 // Degrees
                },
                geometry: {
                    // Pass dimensions or raw point matrices if the target app supports custom specs
                    length: 50,
                    width: 12,
                    height: 10,
                    color: '#00FFBB'
                }
            };

            // 2. Publish the data payload to the shared global event bus.
            // "Select_Geospatial_Event_Topic" represents the listener topic hook 
            // utilized by the Geospatial Design app configuration.
            PlatformAPI.publish('DS/GeospatialDesign/PlotAsset', vesselPayload);

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
