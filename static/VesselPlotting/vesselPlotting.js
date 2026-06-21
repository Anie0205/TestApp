define('VesselPlotting',
[
    'UWA/Core',
    'UWA/Promise',
    'UWA/String',
    'DS/WAFData/WAFData',
    'DS/PlatformAPI/PlatformAPI',
    'DS/UIKIT/Input/Button'
],

function (UWA, Promise, String, WAFData, PlatformAPI, Button) {

    'use strict';

    var VesselWidget = {
        xCityAPI: null,
        THREE: null,
        SceneGraph: null,
        MeshGP: null,
        LineGP: null,
        logContainer: null,

        // On-screen logger function to trace status, partial steps, and errors
        uiLog: function (message, type) {
            if (!this.logContainer) return;
            var color = '#ffffff';
            if (type === 'error') color = '#ff4d4d';
            if (type === 'success') color = '#00ffaa';
            if (type === 'info') color = '#33b5e5';

            var logLine = document.createElement('div');
            logLine.style.color = color;
            logLine.style.marginBottom = '4px';
            logLine.style.fontSize = '12px';
            logLine.style.fontFamily = 'monospace';
            logLine.innerText = '[' + new Date().toLocaleTimeString() + '] ' + message;
            
            this.logContainer.appendChild(logLine);
            this.logContainer.scrollTop = this.logContainer.scrollHeight;
        },

        onLoad: function () {
            var container = widget.body;
            container.setContent('');

            // Build simple UI layout with a log window
            var uiWrapper = document.createElement('div');
            uiWrapper.style.padding = '10px';
            uiWrapper.style.height = '10px';
            
            // Create Logger Panel
            this.logContainer = document.createElement('div');
            this.logContainer.style.background = '#1e1e1e';
            this.logContainer.style.border = '1px solid #333';
            this.logContainer.style.padding = '8px';
            this.logContainer.style.height = '180px';
            this.logContainer.style.overflowY = 'auto';
            this.logContainer.style.marginTop = '10px';
            this.logContainer.style.borderRadius = '4px';
            
            container.appendChild(uiWrapper);
            container.appendChild(this.logContainer);

            this.uiLog("Widget initialized. Starting frame inspection...", "info");

            // Add the action button
            var plotButton = new Button({
                className: 'primary',
                icon: 'location',
                label: 'Plot Rectangle at Coordinates'
            }).inject(uiWrapper);

            var that = this;
            plotButton.addEvent('onClick', function () {
                that.uiLog("Button clicked. Invoking plotting pipeline...", "info");
                that.executePipeline();
            });

            // Start connecting to target map framework
            this.initXCityReference();
        },

        initXCityReference: function () {
            this.uiLog("Searching for Geospatial / City3Dplay iframe component...", "info");

            var cityReferentialWidget = $("[class*='CityReferential']", parent.document)[0];
            var cityDiscoverWidget = $("[class*='City3Dplay']", parent.document)[0];
            var cityWidget = cityReferentialWidget || cityDiscoverWidget;

            if (cityWidget == undefined) {
                this.uiLog("Geospatial Design widget container not found in parent DOM. Retrying...", "error");
                setTimeout(this.initXCityReference.bind(this), 1000);
                return;
            }

            var iframe = cityWidget.querySelector("iframe");
            if (!iframe) {
                this.uiLog("Found map widget container but target iframe is missing.", "error");
                setTimeout(this.initXCityReference.bind(this), 1000);
                return;
            }

            var iframeWindow = iframe.contentWindow;
            if (iframeWindow.xCity == undefined) {
                this.uiLog("Map context (window.xCity) is undefined inside frame. Waiting to initialize...", "error");
                setTimeout(this.initXCityReference.bind(this), 1000);
                return;
            }

            this.uiLog("window.xCity successfully verified. Injecting require context...", "success");

            var that = this;
            iframeWindow.require([
                'DS/UrbanAPI/xCityAPI',
                'DS/Visualization/ThreeJS_DS',
                'DS/Visualization/SceneGraph',
                'DS/Visualization/MeshGP',
                'DS/Visualization/LineGP'
            ], function (xCityAPI, THREE, SceneGraph, MeshGP, LineGP) {
                if (!xCityAPI || !THREE || !SceneGraph || !MeshGP || !LineGP) {
                    that.uiLog("Partial Load Error: One or more 3D internal graphics modules failed to return.", "error");
                } else {
                    that.xCityAPI = xCityAPI;
                    that.THREE = THREE;
                    that.SceneGraph = SceneGraph;
                    that.MeshGP = MeshGP;
                    that.LineGP = LineGP;
                    that.uiLog("All graphics core components securely hooked and ready.", "success");
                }
            });
        },

        executePipeline: function () {
            var lat = 18.94543;
            var lng = 72.92450;
            var alt = 2.0; // Pushed slightly up to prevent ground z-clipping flickering

            if (!this.SceneGraph || !this.THREE) {
                this.uiLog("Execution Aborted: Visualization libs are not fully loaded from frame yet.", "error");
                return;
            }

            try {
                this.uiLog("Step 1: Instantiating Scene Graph node wrapper...", "info");
                var rectNode = this.SceneGraph.createNode({ name: "Simple_Rectangle_Node" });

                // Define local flat rectangle bounds (e.g. 40m x 20m centered around 0,0)
                // Coordinates layout: [X, Y, Z]
                var vertices = [
                    -20, -10, 0,  // Index 0: Bottom-Left
                     20, -10, 0,  // Index 1: Bottom-Right
                     20,  10, 0,  // Index 2: Top-Right
                    -20,  10, 0   // Index 3: Top-Left
                ];

                // Build a filled mesh using 2 distinct triangles
                var indices = [
                    0, 1, 2, 
                    0, 2, 3
                ];

                this.uiLog("Step 2: Creating Mesh Primitive geometry...", "info");
                var meshPrimitive = new this.MeshGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array(indices),
                    fill: true,
                    color: 0x007ACC, // Transparent blue filling
                    opacity: 0.6,
                    side: this.THREE.DoubleSide
                });
                rectNode.addGraphicPrimitive(meshPrimitive);

                this.uiLog("Step 3: Creating Line/Outline Primitive geometry...", "info");
                var boundaryLines = new this.LineGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array([0, 1, 1, 2, 2, 3, 3, 0]), // Outline loop
                    color: 0x00FFBB, // Sharp cyan border line
                    lineWidth: 3
                });
                rectNode.addGraphicPrimitive(boundaryLines);

                this.uiLog("Step 4: Pulling active geospatial global engine...", "info");
                var cityReferentialWidget = $("[class*='CityReferential']", parent.document)[0];
                var cityDiscoverWidget = $("[class*='City3Dplay']", parent.document)[0];
                var activeViewer = (cityReferentialWidget || cityDiscoverWidget).querySelector("iframe").contentWindow.virtualEarthViewer;

                if (!activeViewer) {
                    this.uiLog("Failure at Step 4: virtualEarthViewer instance is inaccessible inside frame.", "error");
                    return;
                }

                this.uiLog("Step 5: Projecting LatLng target to 3D Local World coordinates...", "info");
                var worldPos = activeViewer.getGeospatialManager().fromLatLngToWorld(lat, lng, alt);
                this.uiLog("Calculated Local World Projection Matrix: X=" + worldPos.x.toFixed(2) + ", Y=" + worldPos.y.toFixed(2), "success");

                var matrix = new this.THREE.Matrix4();
                matrix.setPosition(new this.THREE.Vector3(worldPos.x, worldPos.y, worldPos.z));
                rectNode.setMatrix(matrix);

                this.uiLog("Step 6: Appending calculated primitive tree to Scene Root...", "info");
                var rootNode = activeViewer.getRootNode();
                rootNode.addChild(rectNode);

                this.uiLog("Step 7: Forcing dynamic renderer frame refresh...", "info");
                activeViewer.render();

                this.uiLog("Successfully plotted 40x20m Rectangle at target location!", "success");

            } catch (err) {
                this.uiLog("Pipeline Exception occurred: " + err.message, "error");
                console.error(err);
            }
        }
    };

    return VesselWidget;
});