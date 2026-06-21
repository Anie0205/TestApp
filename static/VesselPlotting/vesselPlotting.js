define('VesselPlotting',
[
    'UWA/Core',
    'UWA/Promise',
    'UWA/String',
    'DS/WAFData/WAFData',
    'DS/PlatformAPI/PlatformAPI'
],

function (UWA, Promise, String, WAFData, PlatformAPI) {

    'use strict';

    var VesselWidget = {
        xCityAPI: null,
        xCity: null,

        onLoad: function () {
            // Initialize connection to the Geospatial Design widget frame
            this.initXCityReference(function () {
                console.log("Connected to Geospatial Design context successfully.");
                
                // Example: Plot ship at specific coordinates once ready
                VesselWidget.plotVesselGeom(12.9716, 77.5946, 0.0);
            });
        },

        // Mirroring your exact architecture to grab the map frame's context
        initXCityReference: function (xCityLoadedCallback) {
            if (this.xCity != undefined) {
                if (xCityLoadedCallback) xCityLoadedCallback();
                return;
            }

            // Find the Geospatial Design / City widget containers on the dashboard
            var cityReferentialWidget = $("[class*='CityReferential']", parent.document)[0];
            var cityDiscoverWidget = $("[class*='City3Dplay']", parent.document)[0];
            var cityWidget = cityReferentialWidget || cityDiscoverWidget;

            if (cityWidget == undefined) {
                setTimeout(this.initXCityReference.bind(this, xCityLoadedCallback), 200);
                return;
            }

            var iframeWindow = cityWidget.querySelector("iframe").contentWindow;
            this.xCity = iframeWindow.xCity;
            
            if (this.xCity == undefined) {
                setTimeout(this.initXCityReference.bind(this, xCityLoadedCallback), 200);
                return;
            }

            var that = this;
            // Borrow the require context of the map iframe to get its visualization libraries
            iframeWindow.require([
                'DS/UrbanAPI/xCityAPI',
                'DS/Visualization/ThreeJS_DS',
                'DS/Visualization/SceneGraph',
                'DS/Visualization/MeshGP',
                'DS/Visualization/LineGP'
            ], function (xCityAPI, THREE, SceneGraph, MeshGP, LineGP) {
                if (!xCityAPI) {
                    console.log("xCityAPI or Vis components failed to load from target iframe context.");
                } else {
                    that.xCityAPI = xCityAPI;
                    that.THREE = THREE;
                    that.SceneGraph = SceneGraph;
                    that.MeshGP = MeshGP;
                    that.LineGP = LineGP;
                    
                    if (xCityLoadedCallback) xCityLoadedCallback();
                }
            });
        },

        plotVesselGeom: function (lat, lng, alt) {
            if (!this.SceneGraph) return;

            try {
                // 1. Instantiate the local 3D node from the borrowed SceneGraph context
                var shipNode = this.SceneGraph.createNode({ name: "Custom_Vessel_Asset" });

                // 2. Define vertices relative to center (Meters: [X, Y, Z])
                var vertices = [
                    0,   25,  0,   6,    8,  0,   6,  -25,  0,  -6,  -25,  0,  -6,    8,  0, // Base
                    0,   25, 10,   6,    8, 10,   6,  -25, 10,  -6,  -25, 10,  -6,    8, 10  // Deck
                ];

                var deckIndices = [5, 6, 9, 6, 7, 9, 7, 8, 9];
                var lineIndices = [0,5, 1,6, 2,7, 3,8, 4,9, 5,6, 6,7, 7,8, 8,9, 9,5, 0,1, 1,2, 2,3, 3,4, 4,0];

                // 3. Create the solid deck polygon surface
                shipNode.addGraphicPrimitive(new this.MeshGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array(deckIndices),
                    fill: true,
                    color: 0x222222,
                    opacity: 0.9,
                    side: this.THREE.DoubleSide
                }));

                // 4. Create the wireframe outlines
                shipNode.addGraphicPrimitive(new this.LineGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array(lineIndices),
                    color: 0x00FFBB,
                    lineWidth: 2
                }));

                // 5. Transform geospatial target to map viewport coordinates
                // Grabbing the active viewer directly from the accessed window context
                var cityReferentialWidget = $("[class*='CityReferential']", parent.document)[0];
                var cityDiscoverWidget = $("[class*='City3Dplay']", parent.document)[0];
                var activeViewer = (cityReferentialWidget || cityDiscoverWidget).querySelector("iframe").contentWindow.virtualEarthViewer;

                var worldPos = activeViewer.getGeospatialManager().fromLatLngToWorld(lat, lng, alt);
                
                var transformMatrix = new this.THREE.Matrix4();
                transformMatrix.makeRotationZ(this.THREE.Math.degToRad(60)); // Heading angle
                transformMatrix.setPosition(new this.THREE.Vector3(worldPos.x, worldPos.y, worldPos.z));

                shipNode.setMatrix(transformMatrix);

                // 6. Push directly into the Geospatial view's root scene node
                activeViewer.getRootNode().addChild(shipNode);
                activeViewer.render();

                console.log("Vessel successfully projected into the Geospatial Design Widget space.");

            } catch (e) {
                console.error("Direct context plotting failed: ", e);
            }
        }
    };

    return VesselWidget;
});