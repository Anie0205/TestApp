define('VesselPlotting',
[
    'UWA/Core',
    'DS/PlatformAPI/PlatformAPI',
    'DS/UIKIT/Input/Button'
],

function (UWA, PlatformAPI, Button) {

    'use strict';

    var VesselControllerWidget = {

        onLoad: function () {
            // Create a simple UI container inside your widget frame
            var container = widget.body;
            container.setContent('');

            // Add a UIKIT button to trigger the plotting event
            var plotButton = new Button({
                className: 'primary',
                icon: 'location',
                label: 'Plot Target Vessel'
            }).inject(container);

            // Bind the click action to transmit data
            plotButton.addEvent('onClick', function () {
                VesselControllerWidget.sendVesselToMap();
            });
        },

        sendVesselToMap: function () {
            // 1. Define the structural payload for the asset
            var vesselPayload = {
                action: 'ADD_3D_PRIMITIVE',
                type: 'Vessel',
                coordinates: {
                    lat: 18.94543,
                    lng: 72.92450,
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
            
            console.log("Vessel tracking event dispatched via PlatformAPI.");
        }
    };

    return VesselControllerWidget;
});