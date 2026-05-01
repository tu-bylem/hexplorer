document.addEventListener("DOMContentLoaded", () => {
    const SQUADRATS_ZOOM = 17;

    function getSquareIndex(lat, lng) {
        const x = Math.floor((lng + 180) / 360 * Math.pow(2, SQUADRATS_ZOOM));
        const latRad = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, SQUADRATS_ZOOM));
        return `${x},${y}`;
    }

    function getSquareBounds(index) {
        const parts = index.split(',');
        const x = parseInt(parts[0], 10);
        const y = parseInt(parts[1], 10);
        const n = Math.pow(2, SQUADRATS_ZOOM);

        const lngNW = x / n * 360 - 180;
        const latRadNW = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
        const latNW = latRadNW * 180 / Math.PI;

        const lngSE = (x + 1) / n * 360 - 180;
        const latRadSE = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));
        const latSE = latRadSE * 180 / Math.PI;

        return [
            [latSE, lngNW], // SW
            [latSE, lngSE], // SE
            [latNW, lngSE], // NE
            [latNW, lngNW]  // NW
        ];
    }

    // Inicjalizacja mapy Leaflet
    const map = L.map('map', {
        zoomControl: false // Wyłączamy domyślny kontroler, żeby ui-overlay lepiej wyglądał, można go potem przywrócić
    }).setView([52.2297, 21.0122], 16); // Domyślnie Warszawa (lub inna lokalizacja)

    // Jasny styl mapy z CartoDB
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    let watchId = null;
    let isTracking = false;
    let currentSquare = null;

    // Wczytanie z localStorage
    const exploredSquares = new Set(JSON.parse(localStorage.getItem('hexplorer_explored_squares') || '[]'));
    const savedRoutes = JSON.parse(localStorage.getItem('hexplorer_routes') || '[]');

    // Migracja wsteczna: zamiana stringów na obiekty
    for (let i = 0; i < savedRoutes.length; i++) {
        if (typeof savedRoutes[i] === 'string') {
            savedRoutes[i] = {
                id: 'archive_' + i,
                name: 'Nieznana trasa (Archiwum)',
                source: 'Import',
                distance: 0,
                date: '-',
                polyline: savedRoutes[i]
            };
        }
    }

    // Grupy warstw, aby łatwo je czyścić
    const gridLayerGroup = L.layerGroup().addTo(map);
    const squareLayerGroup = L.layerGroup().addTo(map);
    const routesLayerGroup = L.layerGroup().addTo(map);
    const pathLayerGroup = L.layerGroup().addTo(map);

    function drawBackgroundGrid() {
        gridLayerGroup.clearLayers();
        if (map.getZoom() < 13) return; // Ukryj siatkę przy dalekim przybliżeniu

        const bounds = map.getBounds();
        const n = Math.pow(2, SQUADRATS_ZOOM);

        const nw = getSquareIndex(bounds.getNorth(), bounds.getWest());
        const se = getSquareIndex(bounds.getSouth(), bounds.getEast());

        const startX = parseInt(nw.split(',')[0], 10);
        const startY = parseInt(nw.split(',')[1], 10);
        const endX = parseInt(se.split(',')[0], 10);
        const endY = parseInt(se.split(',')[1], 10);

        for (let x = startX; x <= endX + 1; x++) {
            const lng = x / n * 360 - 180;
            L.polyline([[bounds.getSouth(), lng], [bounds.getNorth(), lng]], { color: '#cbd5e1', weight: 1, opacity: 0.5 }).addTo(gridLayerGroup);
        }

        for (let y = startY; y <= endY + 1; y++) {
            const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
            const lat = latRad * 180 / Math.PI;
            L.polyline([[lat, bounds.getWest()], [lat, bounds.getEast()]], { color: '#cbd5e1', weight: 1, opacity: 0.5 }).addTo(gridLayerGroup);
        }
    }

    map.on('moveend', drawBackgroundGrid);
    map.on('zoomend', drawBackgroundGrid);

    // Linia trasy
    const userPath = [];
    const pathPolyline = L.polyline([], {
        color: '#f97316', // Pomarańczowy ślad dla aktualnej trasy
        weight: 4,
        opacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round'
    }).addTo(pathLayerGroup);

    // Ikona kursora ze strzałką
    const arrowIcon = L.divIcon({
        className: 'user-arrow-icon',
        // Strzałka w górę, będziemy ją obracać na podstawie headingu
        html: `<svg viewBox="0 0 24 24" width="36" height="36">
                 <path d="M12 2L22 22L12 17L2 22L12 2Z" fill="#4ade80" stroke="#0f172a" stroke-width="2" stroke-linejoin="round"/>
               </svg>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
    });

    let userMarker = null;

    // UI Elements
    const uiSquareCount = document.getElementById('square-count');
    const startBtn = document.getElementById('start-btn');
    const resetBtn = document.getElementById('reset-btn');
    const statusMsg = document.getElementById('status-msg');
    const uploadBtn = document.getElementById('upload-btn');
    const dataUpload = document.getElementById('data-upload');

    // Strava elements
    const stravaBtn = document.getElementById('strava-btn');
    const stravaModal = document.getElementById('strava-modal');
    const stravaSaveBtn = document.getElementById('strava-save-btn');
    const stravaCancelBtn = document.getElementById('strava-cancel-btn');
    const stravaClientIdInput = document.getElementById('strava-client-id');
    const stravaClientSecretInput = document.getElementById('strava-client-secret');

    let stravaConfig = JSON.parse(localStorage.getItem('hexplorer_strava_config'));
    let stravaToken = JSON.parse(localStorage.getItem('hexplorer_strava_token'));

    // Panel trasy
    const routeDetailsPanel = document.getElementById('route-details');
    const routeDetailsName = document.getElementById('route-details-name');
    const routeDetailsSource = document.getElementById('route-details-source');
    const routeDetailsDate = document.getElementById('route-details-date');
    const routeDetailsDistance = document.getElementById('route-details-distance');
    const routeDetailsClose = document.getElementById('route-details-close');
    let activePolyline = null;
    
    routeDetailsClose.addEventListener('click', () => {
        routeDetailsPanel.classList.add('hidden');
        if (activePolyline) {
            activePolyline.setStyle({ color: '#f97316', weight: 3, zIndexOffset: 0 });
            activePolyline = null;
        }
    });

    map.on('click', () => {
        routeDetailsPanel.classList.add('hidden');
        if (activePolyline) {
            activePolyline.setStyle({ color: '#f97316', weight: 3, zIndexOffset: 0 });
            activePolyline = null;
        }
    });

    function calculateTotalDistance(points) {
        let dist = 0;
        for (let i = 0; i < points.length - 1; i++) {
            dist += L.latLng(points[i][0], points[i][1]).distanceTo(L.latLng(points[i+1][0], points[i+1][1]));
        }
        return dist;
    }

    function saveExplored() {
        localStorage.setItem('hexplorer_explored_squares', JSON.stringify(Array.from(exploredSquares)));
        uiSquareCount.textContent = exploredSquares.size;
    }

    function addSquaresAlongPath(points) {
        let newCount = 0;
        if (points.length === 0) return 0;
        
        let sq = getSquareIndex(points[0][0], points[0][1]);
        if (!exploredSquares.has(sq)) {
            exploredSquares.add(sq);
            newCount++;
        }

        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            
            const ll1 = L.latLng(p1[0], p1[1]);
            const ll2 = L.latLng(p2[0], p2[1]);
            const dist = ll1.distanceTo(ll2); 
            
            const steps = Math.ceil(dist / 20);
            
            for (let j = 1; j <= steps; j++) {
                const fraction = j / steps;
                const interpLat = p1[0] + (p2[0] - p1[0]) * fraction;
                const interpLng = p1[1] + (p2[1] - p1[1]) * fraction;
                
                const sqIdx = getSquareIndex(interpLat, interpLng);
                if (!exploredSquares.has(sqIdx)) {
                    exploredSquares.add(sqIdx);
                    newCount++;
                }
            }
        }
        return newCount;
    }

    function saveRoutes() {
        localStorage.setItem('hexplorer_routes', JSON.stringify(savedRoutes));
    }

    function drawAllRoutes() {
        routesLayerGroup.clearLayers();
        savedRoutes.forEach(routeObj => {
            const points = decodePolyline(routeObj.polyline);
            const pl = L.polyline(points, { color: '#f97316', weight: 3, opacity: 0.6 }).addTo(routesLayerGroup);
            
            pl.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                if (activePolyline) {
                    activePolyline.setStyle({ color: '#f97316', weight: 3, zIndexOffset: 0 });
                }
                activePolyline = pl;
                pl.setStyle({ color: '#3b82f6', weight: 5, zIndexOffset: 100 });
                pl.bringToFront();
                
                routeDetailsName.textContent = routeObj.name;
                routeDetailsSource.textContent = routeObj.source;
                routeDetailsDate.textContent = routeObj.date || '-';
                routeDetailsDistance.textContent = routeObj.distance ? (routeObj.distance / 1000).toFixed(2) : '-';
                routeDetailsPanel.classList.remove('hidden');
            });
        });
    }

    function drawSquare(squareIndex, isCurrent) {
        const boundary = getSquareBounds(squareIndex);

        const polygon = L.polygon(boundary, {
            color: isCurrent ? '#f8fafc' : '#3b82f6', // Ramka kwadratu
            weight: isCurrent ? 3 : 1,
            opacity: isCurrent ? 1 : 0.3, // Przezroczystość obramowania (mniej widoczne linie)
            fillColor: isCurrent ? '#4ade80' : '#3b82f6', // Wypełnienie
            fillOpacity: isCurrent ? 0.6 : 0.2 // Delikatniejsze wypełnienie
        });

        squareLayerGroup.addLayer(polygon);
        return polygon;
    }

    function redrawAllSquares() {
        squareLayerGroup.clearLayers();

        // Rysuj odwiedzone (z wyjątkiem obecnego, zeby narysowac go na koncu)
        exploredSquares.forEach(sq => {
            if (sq !== currentSquare) {
                drawSquare(sq, false);
            }
        });

        // Obecny kwadrat rysujemy z innym stylem (wyróżniony)
        if (currentSquare) {
            drawSquare(currentSquare, true);
        }
    }

    function updatePosition(position) {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const heading = position.coords.heading || 0; // Kąt w stopniach

        const latlng = [lat, lng];

        // Dodaj punkt do linii trasy
        userPath.push(latlng);
        pathPolyline.setLatLngs(userPath);

        // Aktualizacja lub stworzenie kursora
        if (!userMarker) {
            userMarker = L.marker(latlng, { icon: arrowIcon }).addTo(map);
            map.setView(latlng, 18);
        } else {
            userMarker.setLatLng(latlng);
            // Śledzenie użytkownika mapą - opcjonalnie:
            // map.panTo(latlng);

            // Obrót strzałki
            const iconElement = userMarker.getElement();
            if (iconElement) {
                const svg = iconElement.querySelector('svg');
                if (svg && position.coords.heading !== null) {
                    svg.style.transform = `rotate(${heading}deg)`;
                }
            }
        }

        // Sprawdzanie i zapisywanie kwadratów
        if (userPath.length > 1) {
            const lastPt = userPath[userPath.length - 2];
            const dist = L.latLng(lastPt[0], lastPt[1]).distanceTo(L.latLng(lat, lng));
            const steps = Math.ceil(dist / 20);
            let hasNew = false;
            for (let j = 1; j <= steps; j++) {
                const fraction = j / steps;
                const interpLat = lastPt[0] + (lat - lastPt[0]) * fraction;
                const interpLng = lastPt[1] + (lng - lastPt[1]) * fraction;
                const sqIdx = getSquareIndex(interpLat, interpLng);
                if (!exploredSquares.has(sqIdx)) {
                    exploredSquares.add(sqIdx);
                    hasNew = true;
                }
                currentSquare = sqIdx;
            }
            if (hasNew) saveExplored();
            redrawAllSquares();
        } else {
            const squareIndex = getSquareIndex(lat, lng);
            if (currentSquare !== squareIndex) {
                currentSquare = squareIndex;
                if (!exploredSquares.has(squareIndex)) {
                    exploredSquares.add(squareIndex);
                    saveExplored();
                }
                redrawAllSquares();
            }
        }
    }

    function startTracking() {
        if (!navigator.geolocation) {
            statusMsg.textContent = "Brak wsparcia dla geolokalizacji w Twojej przeglądarce.";
            return;
        }

        isTracking = true;
        startBtn.textContent = "Zatrzymaj";
        statusMsg.textContent = "Oczekiwanie na sygnał GPS...";

        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                statusMsg.textContent = "Śledzenie aktywne (GPS OK)";
                updatePosition(pos);
            },
            (err) => {
                statusMsg.textContent = `Błąd lokalizacji: ${err.message}`;
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 10000
            }
        );
    }

    function stopTracking() {
        isTracking = false;
        startBtn.textContent = "Rozpocznij śledzenie";
        statusMsg.textContent = "Zatrzymano.";
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        if (userPath.length > 0) {
            const dist = calculateTotalDistance(userPath);
            savedRoutes.push({
                id: 'live_' + Date.now(),
                name: 'Trasa z aplikacji',
                source: 'Aplikacja',
                distance: dist,
                date: new Date().toLocaleDateString(),
                polyline: encodePolyline(userPath)
            });
            saveRoutes();
            drawAllRoutes();
            userPath.length = 0;
            pathPolyline.setLatLngs([]);
        }
    }

    // Zdarzenia przycisków
    startBtn.addEventListener('click', () => {
        if (isTracking) {
            stopTracking();
        } else {
            startTracking();
        }
    });

    resetBtn.addEventListener('click', () => {
        if (confirm("Czy na pewno chcesz zresetować wszystkie odkryte tereny i trasę?")) {
            exploredSquares.clear();
            userPath.length = 0;
            pathPolyline.setLatLngs([]);
            savedRoutes.length = 0;
            currentSquare = null;
            saveExplored();
            saveRoutes();
            localStorage.removeItem('hexplorer_strava_last_sync');
            redrawAllSquares();
            drawAllRoutes();
            statusMsg.textContent = "Zresetowano postęp.";
        }
    });

    const exportBtn = document.getElementById('export-btn');
    const importBtn = document.getElementById('import-btn');
    const importUpload = document.getElementById('import-upload');

    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const data = {
                squares: Array.from(exploredSquares),
                routes: savedRoutes
            };
            const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `hexplorer_backup_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            statusMsg.textContent = "Pobrano plik z kopią zapasową.";
        });
    }

    if (importBtn && importUpload) {
        importBtn.addEventListener('click', () => {
            importUpload.click();
        });

        importUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    if (data.squares && data.routes) {
                        exploredSquares.clear();
                        data.squares.forEach(sq => exploredSquares.add(sq));
                        savedRoutes.length = 0;
                        data.routes.forEach(r => savedRoutes.push(r));
                        
                        saveExplored();
                        saveRoutes();
                        redrawAllSquares();
                        drawAllRoutes();
                        
                        statusMsg.textContent = "Pomyślnie zaimportowano postęp z pliku!";
                    } else {
                        statusMsg.textContent = "Nieprawidłowy plik kopii zapasowej.";
                    }
                } catch (err) {
                    statusMsg.textContent = "Błąd podczas wczytywania pliku.";
                    console.error(err);
                }
                importUpload.value = ''; // reset
            };
            reader.readAsText(file);
        });
    }

    uploadBtn.addEventListener('click', () => {
        dataUpload.click();
    });

    dataUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        statusMsg.textContent = "Przetwarzanie pliku...";
        const reader = new FileReader();

        reader.onload = (event) => {
            const content = event.target.result;

            if (file.name.toLowerCase().endsWith('.gpx') || file.name.toLowerCase().endsWith('.tcx')) {
                parseXMLAndAddSquares(content, file.name.toLowerCase());
            } else if (file.name.toLowerCase().endsWith('.json')) {
                parseJSONAndAddSquares(content);
            } else {
                statusMsg.textContent = "Nieobsługiwany format pliku. Użyj GPX, TCX lub JSON.";
            }
            // Zresetuj input, by móc wgrać ten sam plik jeszcze raz, jeśli potrzeba
            dataUpload.value = '';
        };

        reader.readAsText(file);
    });

    function parseXMLAndAddSquares(xmlText, fileName) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlText, "text/xml");

            let addedCount = 0;
            let lastPoint = null;
            const currentRoutePoints = [];

            if (fileName.endsWith('.gpx')) {
                const trackPoints = doc.querySelectorAll("trkpt");
                trackPoints.forEach(pt => {
                    const lat = parseFloat(pt.getAttribute("lat"));
                    const lon = parseFloat(pt.getAttribute("lon"));

                    if (!isNaN(lat) && !isNaN(lon)) {
                        lastPoint = [lat, lon];
                        currentRoutePoints.push([lat, lon]);
                    }
                });
            } else if (fileName.endsWith('.tcx')) {
                // TCX structure: <Trackpoint><Position><LatitudeDegrees>52.0</LatitudeDegrees>...
                const trackPoints = doc.querySelectorAll("Position");
                trackPoints.forEach(pt => {
                    const latNode = pt.querySelector("LatitudeDegrees");
                    const lonNode = pt.querySelector("LongitudeDegrees");
                    if (latNode && lonNode) {
                        const lat = parseFloat(latNode.textContent);
                        const lon = parseFloat(lonNode.textContent);
                        if (!isNaN(lat) && !isNaN(lon)) {
                            lastPoint = [lat, lon];
                            currentRoutePoints.push([lat, lon]);
                        }
                    }
                });
            }

            if (currentRoutePoints.length > 0) {
                addedCount += addSquaresAlongPath(currentRoutePoints);
                const dist = calculateTotalDistance(currentRoutePoints);
                savedRoutes.push({
                    id: 'local_' + Date.now(),
                    name: fileName || 'Wgrana trasa',
                    source: 'Import',
                    distance: dist,
                    date: new Date().toLocaleDateString(),
                    polyline: encodePolyline(currentRoutePoints)
                });
                saveRoutes();
                drawAllRoutes();
            }

            if (addedCount > 0) {
                saveExplored();
                redrawAllSquares();
                if (lastPoint) {
                    map.setView(lastPoint, 14);
                }
            }

            const ext = fileName.endsWith('.gpx') ? 'GPX' : 'TCX';
            statusMsg.textContent = `Wgrano dane ${ext}. Odblokowano ${addedCount} nowych kwadratów!`;
        } catch (err) {
            statusMsg.textContent = "Błąd podczas parsowania pliku trasy.";
            console.error(err);
        }
    }

    function parseJSONAndAddSquares(jsonText) {
        try {
            const data = JSON.parse(jsonText);
            let addedCount = 0;
            let lastPoint = null;
            const currentRoutePoints = [];

            const processPoint = (item) => {
                let lat, lng;
                if (Array.isArray(item) && item.length >= 2) {
                    lat = item[0];
                    lng = item[1];
                } else if (item.lat !== undefined && item.lng !== undefined) {
                    lat = item.lat;
                    lng = item.lng;
                } else if (item.latitude !== undefined && item.longitude !== undefined) {
                    lat = item.latitude;
                    lng = item.longitude;
                }

                if (lat !== undefined && lng !== undefined) {
                    lastPoint = [lat, lng];
                    currentRoutePoints.push([lat, lng]);
                }
            };

            if (Array.isArray(data)) {
                data.forEach(processPoint);
            } else if (data.locations && Array.isArray(data.locations)) { // Np. Google Location History
                data.locations.forEach(processPoint);
            } else if (data.features) { // GeoJSON
                data.features.forEach(f => {
                    if (f.geometry && f.geometry.type === "Point") {
                        processPoint([f.geometry.coordinates[1], f.geometry.coordinates[0]]); // GeoJSON uzywa [lng, lat]
                    } else if (f.geometry && f.geometry.type === "LineString") {
                        f.geometry.coordinates.forEach(coord => {
                            processPoint([coord[1], coord[0]]);
                        });
                    }
                });
            }

            if (currentRoutePoints.length > 0) {
                addedCount += addSquaresAlongPath(currentRoutePoints);
                const dist = calculateTotalDistance(currentRoutePoints);
                savedRoutes.push({
                    id: 'local_' + Date.now(),
                    name: 'Wgrana trasa JSON',
                    source: 'Import JSON',
                    distance: dist,
                    date: new Date().toLocaleDateString(),
                    polyline: encodePolyline(currentRoutePoints)
                });
                saveRoutes();
                drawAllRoutes();
            }

            if (addedCount > 0) {
                saveExplored();
                redrawAllSquares();
                if (lastPoint) {
                    map.setView(lastPoint, 14);
                }
            }
            statusMsg.textContent = `Wgrano dane JSON. Odblokowano ${addedCount} nowych kwadratów!`;
        } catch (e) {
            statusMsg.textContent = "Błąd parsowania pliku JSON.";
            console.error(e);
        }
    }

    // --- STRAVA API LOGIC ---
    function encodeNumber(num) {
        let output = '';
        num = num < 0 ? ~(num << 1) : (num << 1);
        while (num >= 0x20) {
            output += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
            num >>= 5;
        }
        output += String.fromCharCode(num + 63);
        return output;
    }

    function encodePolyline(coordinates, precision = 5) {
        if (!coordinates.length) return '';
        const factor = Math.pow(10, precision);
        let output = '';
        let lat = 0, lng = 0;

        for (let i = 0; i < coordinates.length; i++) {
            let latDiff = Math.round(coordinates[i][0] * factor) - lat;
            let lngDiff = Math.round(coordinates[i][1] * factor) - lng;
            lat += latDiff;
            lng += lngDiff;
            output += encodeNumber(latDiff) + encodeNumber(lngDiff);
        }
        return output;
    }

    function decodePolyline(str, precision) {
        let index = 0, lat = 0, lng = 0, coordinates = [], shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = Math.pow(10, precision || 5);
        while (index < str.length) {
            byte = null; shift = 0; result = 0;
            do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
            latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
            shift = result = 0;
            do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
            longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += latitude_change; lng += longitude_change;
            coordinates.push([lat / factor, lng / factor]);
        }
        return coordinates;
    }

    function updateStravaBtnState() {
        if (stravaToken) {
            stravaBtn.textContent = "Synchronizuj ze Stravą";
            stravaBtn.style.backgroundColor = "#4ade80"; // Zielony - zalogowano
        } else {
            stravaBtn.textContent = "Połącz ze Stravą";
            stravaBtn.style.backgroundColor = "#fc4c02"; // Pomarańczowy Strava
        }
    }

    stravaBtn.addEventListener('click', () => {
        if (stravaToken) {
            syncStravaActivities();
        } else if (stravaConfig) {
            const redirectUri = window.location.origin + window.location.pathname;
            const authUrl = `https://www.strava.com/oauth/authorize?client_id=${stravaConfig.clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=auto&scope=activity:read_all`;
            window.location.href = authUrl;
        } else {
            stravaModal.style.display = 'flex';
        }
    });

    stravaCancelBtn.addEventListener('click', () => {
        stravaModal.style.display = 'none';
    });

    stravaSaveBtn.addEventListener('click', () => {
        const clientId = stravaClientIdInput.value.trim();
        const clientSecret = stravaClientSecretInput.value.trim();
        if (clientId && clientSecret) {
            stravaConfig = { clientId, clientSecret };
            localStorage.setItem('hexplorer_strava_config', JSON.stringify(stravaConfig));
            stravaModal.style.display = 'none';

            const redirectUri = window.location.origin + window.location.pathname;
            const authUrl = `https://www.strava.com/oauth/authorize?client_id=${stravaConfig.clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=auto&scope=activity:read_all`;
            window.location.href = authUrl;
        } else {
            alert("Podaj Client ID i Client Secret.");
        }
    });

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    if (code && stravaConfig) {
        statusMsg.textContent = "Autoryzacja Strava w toku...";
        window.history.replaceState({}, document.title, window.location.pathname);

        fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: stravaConfig.clientId,
                client_secret: stravaConfig.clientSecret,
                code: code,
                grant_type: 'authorization_code'
            })
        })
            .then(res => res.json())
            .then(data => {
                if (data.access_token) {
                    stravaToken = data;
                    localStorage.setItem('hexplorer_strava_token', JSON.stringify(data));
                    updateStravaBtnState();
                    syncStravaActivities();
                } else {
                    statusMsg.textContent = "Błąd autoryzacji Strava. Sprawdź poprawność kluczy API.";
                }
            })
            .catch(err => {
                statusMsg.textContent = "Błąd połączenia ze Stravą.";
                console.error(err);
            });
    }

    async function checkStravaToken() {
        if (!stravaToken) return false;
        const now = Math.floor(Date.now() / 1000);
        if (stravaToken.expires_at && stravaToken.expires_at < now) {
            try {
                const res = await fetch('https://www.strava.com/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: stravaConfig.clientId,
                        client_secret: stravaConfig.clientSecret,
                        refresh_token: stravaToken.refresh_token,
                        grant_type: 'refresh_token'
                    })
                });
                const data = await res.json();
                if (data.access_token) {
                    stravaToken = data;
                    localStorage.setItem('hexplorer_strava_token', JSON.stringify(data));
                    return true;
                } else {
                    return false;
                }
            } catch (e) {
                return false;
            }
        }
        return true;
    }

    async function syncStravaActivities() {
        statusMsg.textContent = "Pobieranie aktywności ze Stravy...";
        const isValid = await checkStravaToken();
        if (!isValid) {
            statusMsg.textContent = "Wygasł token Strava. Zaloguj się ponownie.";
            stravaToken = null;
            localStorage.removeItem('hexplorer_strava_token');
            updateStravaBtnState();
            return;
        }

        const lastSync = parseInt(localStorage.getItem('hexplorer_strava_last_sync') || '0');

        try {
            const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?per_page=200&after=${lastSync}`, {
                headers: { 'Authorization': `Bearer ${stravaToken.access_token}` }
            });
            const activities = await res.json();

            if (!Array.isArray(activities)) {
                statusMsg.textContent = "Błąd limitu zapytań lub dostępu do Stravy.";
                return;
            }

            if (activities.length === 0) {
                statusMsg.textContent = "Brak nowych aktywności od ostatniej synchronizacji.";
                return;
            }

            let addedCount = 0;
            let maxDate = lastSync;
            let lastPoint = null;

            activities.forEach(act => {
                const actDate = new Date(act.start_date).getTime() / 1000;
                if (actDate > maxDate) maxDate = actDate;

                if (act.map && act.map.summary_polyline) {
                    savedRoutes.push({
                        id: 'strava_' + act.id,
                        name: act.name,
                        source: 'Strava',
                        distance: act.distance || 0,
                        date: new Date(act.start_date).toLocaleDateString(),
                        polyline: act.map.summary_polyline
                    });
                    const points = decodePolyline(act.map.summary_polyline);
                    if (points.length > 0) {
                        lastPoint = points[points.length - 1];
                        addedCount += addSquaresAlongPath(points);
                    }
                }
            });

            saveRoutes();
            drawAllRoutes();

            if (addedCount > 0) {
                saveExplored();
                redrawAllSquares();
                if (lastPoint) {
                    map.setView(lastPoint, 14);
                }
            }

            localStorage.setItem('hexplorer_strava_last_sync', Math.floor(maxDate).toString());
            statusMsg.textContent = `Pobrano ${activities.length} aktywności. Nowe kwadraty: ${addedCount}.`;

        } catch (err) {
            statusMsg.textContent = "Wystąpił błąd podczas komunikacji z API Stravy.";
            console.error(err);
        }
    }

    // Inicjalizacja interfejsu
    updateStravaBtnState();
    uiSquareCount.textContent = exploredSquares.size;
    redrawAllSquares();
    drawAllRoutes();
    drawBackgroundGrid();
});
