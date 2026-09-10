import "./App.css";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Marker,
  Popup,
  useMap
} from "react-leaflet";

import "leaflet/dist/leaflet.css";
import L from "leaflet";


// ============================================================
// FIX LEAFLET MARKER ICONS
// ============================================================

delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",

  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",

  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"
});


// ============================================================
// ROUTE COLORS
// ============================================================

const routeColors = {
  1: "#16a34a",
  2: "#f59e0b",
  3: "#dc2626"
};

function getRouteColor(route) {
  const rank = Number(route?.safety_rank ?? route?.rank ?? 0);

  if (route?.recommended === true || rank === 1) return "#16a34a";
  if (rank === 2) return "#f59e0b";
  if (rank === 3) return "#dc2626";

  return "#2563eb";
}


// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getTrafficCondition(score) {
  if (score >= 80) {
    return "Low Traffic";
  }

  if (score >= 50) {
    return "Moderate Traffic";
  }

  if (score >= 30) {
    return "Heavy Traffic";
  }

  return "Very Heavy Traffic";
}


function getWeatherRisk(score) {
  if (score >= 80) {
    return "Good";
  }

  if (score >= 60) {
    return "Moderate";
  }

  if (score >= 40) {
    return "Poor";
  }

  return "Very Poor";
}


function getLightingCondition(score) {
  if (score >= 80) {
    return "Good Visibility";
  }

  if (score >= 50) {
    return "Moderate Visibility";
  }

  if (score >= 30) {
    return "Low Visibility";
  }

  return "Very Low Visibility";
}


function getCrimeRisk(score) {
  if (score <= 20) {
    return "Low Crime Risk";
  }

  if (score <= 40) {
    return "Moderate Crime Risk";
  }

  if (score <= 60) {
    return "High Crime Risk";
  }

  return "Very High Crime Risk";
}


function getSafetyRisk(score) {
  if (score < 30) return "Very High Risk";
  if (score < 45) return "High Risk";
  if (score < 60) return "Medium Risk";
  if (score < 75) return "Low Risk";
  return "Very Low Risk";
}


// ============================================================
// NAVIGATION HELPERS
// ============================================================

function formatNavigationDistance(meters) {
  const value = Number(meters || 0);

  if (value < 1000) {
    return `${Math.max(0, Math.round(value / 10) * 10)} m`;
  }

  return `${(value / 1000).toFixed(1)} km`;
}

function formatNavigationTime(minutes) {
  const value = Math.max(0, Math.round(Number(minutes || 0)));

  if (value < 60) {
    return `${value} min`;
  }

  const hours = Math.floor(value / 60);
  const mins = value % 60;

  return mins === 0
    ? `${hours} hr`
    : `${hours} hr ${mins} min`;
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const toRadians = (value) => value * Math.PI / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}


function calculateBearingDegrees(lat1, lon1, lat2, lon2) {
  const toRadians = (value) => value * Math.PI / 180;
  const toDegrees = (value) => value * 180 / Math.PI;

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaLambda = toRadians(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}


// ============================================================
// SMOOTH MOVING NAVIGATION POINTER
// ============================================================

function createNavigationPointerIcon(heading = 0) {
  const safeHeading = Number.isFinite(Number(heading))
    ? Number(heading)
    : 0;

  return L.divIcon({
    className: "saferoute-navigation-pointer",
    iconSize: [52, 52],
    iconAnchor: [26, 26],
    popupAnchor: [0, -26],
    html: `
      <div style="
        width:52px;
        height:52px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:rotate(${safeHeading}deg);
        transform-origin:center center;
      ">
        <div style="
          width:40px;
          height:40px;
          border-radius:50%;
          background:rgba(37,99,235,0.20);
          border:2px solid rgba(255,255,255,0.95);
          box-shadow:0 3px 14px rgba(15,23,42,0.38);
          display:flex;
          align-items:center;
          justify-content:center;
        ">
          <div style="
            width:0;
            height:0;
            border-left:9px solid transparent;
            border-right:9px solid transparent;
            border-bottom:24px solid #2563eb;
            filter:drop-shadow(0 2px 2px rgba(15,23,42,0.35));
            transform:translateY(-2px);
          "></div>
        </div>
      </div>
    `
  });
}


function MovingLocationPointer({
  position,
  heading = 0,
  popupText = "Your current location"
}) {
  const initialPosition = position
    ? [Number(position.latitude), Number(position.longitude)]
    : null;

  const [animatedPosition, setAnimatedPosition] =
    useState(initialPosition);

  const animatedPositionRef =
    useRef(initialPosition);

  useEffect(() => {
    if (!position) return undefined;

    const target = [
      Number(position.latitude),
      Number(position.longitude)
    ];

    if (
      !Number.isFinite(target[0]) ||
      !Number.isFinite(target[1])
    ) {
      return undefined;
    }

    const from =
      animatedPositionRef.current || target;

    const startLat = Number(from[0]);
    const startLon = Number(from[1]);

    if (
      !Number.isFinite(startLat) ||
      !Number.isFinite(startLon)
    ) {
      animatedPositionRef.current = target;
      setAnimatedPosition(target);
      return undefined;
    }

    const distance = haversineDistanceMeters(
      startLat,
      startLon,
      target[0],
      target[1]
    );

    const duration = Math.min(
      900,
      Math.max(250, 350 + distance * 2)
    );

    const startedAt = performance.now();
    let animationFrame = null;

    const animate = (now) => {
      const progress = Math.min(
        1,
        (now - startedAt) / duration
      );

      const smoothProgress =
        progress * progress * (3 - 2 * progress);

      const nextPosition = [
        startLat +
          (target[0] - startLat) * smoothProgress,
        startLon +
          (target[1] - startLon) * smoothProgress
      ];

      animatedPositionRef.current = nextPosition;
      setAnimatedPosition(nextPosition);

      if (progress < 1) {
        animationFrame =
          requestAnimationFrame(animate);
      }
    };

    animationFrame =
      requestAnimationFrame(animate);

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [
    position?.latitude,
    position?.longitude
  ]);

  if (!animatedPosition) return null;

  return (
    <Marker
      position={animatedPosition}
      icon={createNavigationPointerIcon(heading)}
      zIndexOffset={2000}
    >
      <Popup>
        <strong>📍 {popupText}</strong>
        <br />
        {Number(position?.accuracy || 0) > 0
          ? `GPS accuracy: ${Math.round(position.accuracy)} m`
          : "GPS location active"}
        <br />
        Direction: {Math.round(Number(heading) || 0)}°
      </Popup>
    </Marker>
  );
}


function getNearestRoutePointInfo(position, coordinates) {
  if (!position || !Array.isArray(coordinates) || coordinates.length === 0) {
    return { index: 0, distance: Infinity };
  }

  let nearestIndex = 0;
  let nearestDistance = Infinity;

  coordinates.forEach((point, index) => {
    if (!Array.isArray(point) || point.length < 2) return;

    const longitude = Number(point[0]);
    const latitude = Number(point[1]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const distance = haversineDistanceMeters(
      position.latitude,
      position.longitude,
      latitude,
      longitude
    );

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return { index: nearestIndex, distance: nearestDistance };
}

function getNearestRoutePointIndex(position, coordinates) {
  return getNearestRoutePointInfo(position, coordinates).index;
}

function getRouteDistanceBetweenIndices(coordinates, startIndex, endIndex) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;

  const start = Math.max(0, Math.min(Number(startIndex) || 0, coordinates.length - 1));
  const end = Math.max(start, Math.min(Number(endIndex) || 0, coordinates.length - 1));

  let distance = 0;

  for (let index = start; index < end; index += 1) {
    const a = coordinates[index];
    const b = coordinates[index + 1];

    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) continue;

    distance += haversineDistanceMeters(
      Number(a[1]), Number(a[0]),
      Number(b[1]), Number(b[0])
    );
  }

  return distance;
}

function getNavigationInstructionIndex(instructions, nearestPointIndex) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    return 0;
  }

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const interval = Array.isArray(instruction?.interval)
      ? instruction.interval
      : [0, 0];

    const endIndex = Number(interval[1] ?? 0);

    if (nearestPointIndex <= endIndex) {
      return index;
    }
  }

  return instructions.length - 1;
}

function getNavigationTurnIcon(sign) {
  const value = Number(sign);

  if (value === -3) return "↙️";
  if (value === -2) return "⬅️";
  if (value === -1) return "↖️";
  if (value === 1) return "↗️";
  if (value === 2) return "➡️";
  if (value === 3) return "↘️";
  if (value === 6) return "🔄";
  if (value === 7) return "↱";
  if (value === -7) return "↰";
  if (value === 4) return "🏁";
  return "⬆️";
}

function NavigationMapController({
  navigationActive,
  currentPosition
}) {
  const map = useMap();

  useEffect(() => {
    if (!navigationActive || !currentPosition) return;

    map.setView(
      [currentPosition.latitude, currentPosition.longitude],
      Math.max(map.getZoom(), 16),
      { animate: true }
    );
  }, [map, navigationActive, currentPosition]);

  useEffect(() => {
    const handleRecenter = () => {
      if (!currentPosition) return;

      map.setView(
        [currentPosition.latitude, currentPosition.longitude],
        Math.max(map.getZoom(), 16),
        { animate: true }
      );
    };

    window.addEventListener(
      "saferoute-recenter",
      handleRecenter
    );

    return () => {
      window.removeEventListener(
        "saferoute-recenter",
        handleRecenter
      );
    };
  }, [map, currentPosition]);

  return null;
}

function LiveSafetyPanel({ liveSafety, loading, error }) {
  if (!liveSafety && !loading && !error) return null;

  const safetyScore = Number(liveSafety?.safety_score ?? 0);
  const crimeRisk = Number(liveSafety?.crime?.risk_score ?? 0);
  const lighting = Number(liveSafety?.lighting?.score ?? 0);
  const traffic = Number(liveSafety?.traffic?.score ?? 0);
  const weather = Number(liveSafety?.weather?.score ?? 0);

  const safetyClass =
    safetyScore >= 75 ? "LOW RISK" :
    safetyScore >= 60 ? "MODERATE" :
    safetyScore >= 45 ? "HIGH RISK" :
    "VERY HIGH RISK";

  const cardStyle = {
    background: "rgba(255,255,255,0.96)",
    border: "1px solid #e2e8f0",
    borderRadius: "14px",
    padding: "12px",
    boxShadow: "0 5px 18px rgba(15,23,42,0.10)"
  };

  return (
    <section
      style={{
        margin: "14px 0",
        borderRadius: "16px",
        padding: "16px",
        background: "linear-gradient(135deg, #ecfeff, #eff6ff)",
        border: "1px solid #cbd5e1"
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap"
        }}
      >
        <div>
          <div style={{ fontSize: "0.78rem", fontWeight: 800, color: "#475569", textTransform: "uppercase" }}>
            📍 Live area safety
          </div>
          <h2 style={{ margin: "3px 0 0", color: "#0f172a" }}>
            {liveSafety?.crime?.location && liveSafety.crime.location !== "Unknown"
              ? liveSafety.crime.location
              : "Current area"}
          </h2>
        </div>

        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "0.76rem", color: "#64748b" }}>AI safety prediction</div>
          <strong style={{ fontSize: "1.5rem", color: safetyScore >= 60 ? "#15803d" : "#dc2626" }}>
            {loading ? "..." : `${Math.round(safetyScore)}/100`}
          </strong>
          {liveSafety && (
            <div style={{ fontSize: "0.72rem", fontWeight: 800, color: "#475569" }}>
              {safetyClass}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: "10px", padding: "9px 11px", borderRadius: "10px", background: "#fee2e2", color: "#991b1b", fontWeight: 700 }}>
          ⚠️ {error}
        </div>
      )}

      {liveSafety && (
        <>
          <div
            style={{
              marginTop: "12px",
              padding: "11px 13px",
              borderRadius: "11px",
              background:
                liveSafety.alert_type === "none" ? "#dcfce7" : "#fef3c7",
              color:
                liveSafety.alert_type === "none" ? "#166534" : "#92400e",
              fontWeight: 800
            }}
          >
            {liveSafety.alert_type === "none" ? "✓" : "⚠️"} {liveSafety.safety_alert}
          </div>

          <div
            style={{
              marginTop: "12px",
              display: "grid",
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
              gap: "8px"
            }}
          >
            <div style={cardStyle}>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>🌙 Lighting</div>
              <strong>{Math.round(lighting)}/100</strong>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>🚗 Traffic</div>
              <strong>{Math.round(traffic)}/100</strong>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>🌦️ Weather</div>
              <strong>{Math.round(weather)}/100</strong>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>🚨 Crime risk</div>
              <strong>{Math.round(crimeRisk)}/100</strong>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>👁️ Visibility</div>
              <strong>{Number(liveSafety.weather?.visibility_km ?? 0).toFixed(1)} km</strong>
            </div>
          </div>

          <div
            style={{
              marginTop: "10px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "8px",
              fontSize: "0.84rem",
              color: "#334155"
            }}
          >
            <div>🌡️ {Number(liveSafety.weather?.temperature_c ?? 0).toFixed(1)} °C · {liveSafety.weather?.condition || "Unknown"}</div>
            <div>💧 {Math.round(Number(liveSafety.weather?.humidity_percent ?? 0))}% humidity</div>
            <div>💨 {Number(liveSafety.weather?.wind_speed_kmph ?? 0).toFixed(1)} km/h wind</div>
          </div>
        </>
      )}

      <div style={{ marginTop: "9px", fontSize: "0.72rem", color: "#64748b" }}>
        Live checks refresh during navigation. Crime information represents available crime-risk data/model output; it does not guarantee that a crime will occur.
      </div>
    </section>
  );
}

function NavigationPanel({
  selectedRoute,
  navigationActive,
  currentPosition,
  currentInstructionIndex,
  onStart,
  onDemoStart,
  onStop,
  onRecenter,
  gpsError,
  offRoute,
  rerouting,
  rerouteMessage,
  onShareCurrent,
  onStartLiveShare,
  onStopLiveShare,
  locationShareActive,
  locationShareUrl,
  locationShareMessage,
  demoNavigationActive
}) {
  if (!selectedRoute) return null;

  const instructions = Array.isArray(
    selectedRoute.navigation_instructions
  )
    ? selectedRoute.navigation_instructions
    : [];

  const currentInstruction =
    instructions[currentInstructionIndex] ||
    instructions[0] ||
    null;

  const routeCoordinates = Array.isArray(selectedRoute.coordinates)
    ? selectedRoute.coordinates
    : [];

  const nearestRoute = currentPosition
    ? getNearestRoutePointInfo(currentPosition, routeCoordinates)
    : { index: 0, distance: Infinity };

  const currentPointIndex = nearestRoute.index;
  const isActuallyOnRoute = nearestRoute.distance <= 120;
  const isNearRoute = nearestRoute.distance <= 2000;

  const instructionInterval = Array.isArray(currentInstruction?.interval)
    ? currentInstruction.interval
    : [0, 0];

  const targetIndex = Math.min(
    Number(instructionInterval[1] || 0),
    Math.max(0, routeCoordinates.length - 1)
  );

  let distanceToNextTurn = Number(currentInstruction?.distance_m || 0);

  if (currentPosition && isActuallyOnRoute && routeCoordinates.length > 1) {
    distanceToNextTurn = getRouteDistanceBetweenIndices(
      routeCoordinates,
      currentPointIndex,
      targetIndex
    );
  }

  const totalRouteDistance = Number(selectedRoute.distance_km || 0) * 1000;

  const remainingDistance = isActuallyOnRoute
    ? getRouteDistanceBetweenIndices(
        routeCoordinates,
        currentPointIndex,
        Math.max(0, routeCoordinates.length - 1)
      )
    : totalRouteDistance;

  const remainingMinutes = totalRouteDistance > 0
    ? Number(selectedRoute.time_minutes || 0) *
      Math.min(1, remainingDistance / totalRouteDistance)
    : Number(selectedRoute.time_minutes || 0);

  return (
    <section
      style={{
        margin: "18px 0",
        padding: "18px",
        borderRadius: "16px",
        background: "linear-gradient(135deg, #0f172a, #1e3a8a)",
        color: "#ffffff",
        boxShadow: "0 10px 28px rgba(15,23,42,0.22)"
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap"
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.8rem",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              opacity: 0.8
            }}
          >
            🧭 LIVE NAVIGATION
          </div>
          <h2 style={{ margin: "4px 0 0" }}>
            Route {selectedRoute.route_id}
            {selectedRoute.recommended ? " — Recommended" : ""}
          </h2>
          {selectedRoute.rerouted && (
            <div
              style={{
                marginTop: "5px",
                fontSize: "0.78rem",
                fontWeight: 800,
                color: "#bfdbfe"
              }}
            >
              🔄 Live rerouted route
            </div>
          )}
          {demoNavigationActive && (
            <div style={{ marginTop: "6px", fontSize: "0.78rem", fontWeight: 800, color: "#ddd6fe" }}>
              🎬 DEMO MODE — simulated GPS movement
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {!navigationActive ? (
            <>
              <button
                onClick={onStart}
                style={{
                border: "none",
                borderRadius: "10px",
                padding: "11px 16px",
                background: "#22c55e",
                color: "#ffffff",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
                ▶ Start Navigation
              </button>

              <button
                onClick={onDemoStart}
                disabled={!selectedRoute}
                style={{
                  border: "none",
                  borderRadius: "10px",
                  padding: "11px 16px",
                  background: "#7c3aed",
                  color: "#ffffff",
                  fontWeight: 800,
                  cursor: "pointer"
                }}
              >
                🎬 Demo Navigation
              </button>
            </>
          ) : (
            <button
              onClick={onStop}
              style={{
                border: "none",
                borderRadius: "10px",
                padding: "11px 16px",
                background: "#ef4444",
                color: "#ffffff",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              ■ Stop
            </button>
          )}

          {currentPosition && (
            <button
              onClick={onRecenter}
              style={{
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: "10px",
                padding: "11px 16px",
                background: "rgba(255,255,255,0.12)",
                color: "#ffffff",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              ◎ Recenter
            </button>
          )}
        </div>
      </div>


      <div
        style={{
          marginTop: "12px",
          display: "flex",
          gap: "8px",
          flexWrap: "wrap"
        }}
      >
        <button
          onClick={onShareCurrent}
          disabled={!currentPosition}
          style={{
            border: "1px solid rgba(255,255,255,0.35)",
            borderRadius: "10px",
            padding: "10px 14px",
            background: "rgba(255,255,255,0.12)",
            color: "#ffffff",
            fontWeight: 700,
            cursor: currentPosition ? "pointer" : "not-allowed",
            opacity: currentPosition ? 1 : 0.55
          }}
        >
          📍 Share Current Location
        </button>

        {!locationShareActive ? (
          <button
            onClick={onStartLiveShare}
            disabled={!currentPosition}
            style={{
              border: "none",
              borderRadius: "10px",
              padding: "10px 14px",
              background: "#16a34a",
              color: "#ffffff",
              fontWeight: 800,
              cursor: currentPosition ? "pointer" : "not-allowed",
              opacity: currentPosition ? 1 : 0.55
            }}
          >
            🟢 Share Live Location
          </button>
        ) : (
          <button
            onClick={onStopLiveShare}
            style={{
              border: "none",
              borderRadius: "10px",
              padding: "10px 14px",
              background: "#dc2626",
              color: "#ffffff",
              fontWeight: 800,
              cursor: "pointer"
            }}
          >
            ■ Stop Live Sharing
          </button>
        )}
      </div>

      {locationShareActive && locationShareUrl && (
        <div
          style={{
            marginTop: "10px",
            padding: "11px 12px",
            borderRadius: "10px",
            background: "rgba(34,197,94,0.16)",
            color: "#dcfce7",
            fontSize: "0.82rem",
            wordBreak: "break-all"
          }}
        >
          <strong>🟢 Live sharing link:</strong>
          <br />
          {locationShareUrl}
        </div>
      )}

      {locationShareMessage && (
        <div
          style={{
            marginTop: "8px",
            fontSize: "0.82rem",
            color: "#dbeafe"
          }}
        >
          {locationShareMessage}
        </div>
      )}

      {gpsError && (
        <div
          style={{
            marginTop: "12px",
            padding: "10px 12px",
            borderRadius: "10px",
            background: "rgba(239,68,68,0.18)",
            color: "#fecaca"
          }}
        >
          ⚠️ {gpsError}
        </div>
      )}

      {offRoute && (
        <div
          style={{
            marginTop: "12px",
            padding: "10px 12px",
            borderRadius: "10px",
            background: "rgba(245,158,11,0.18)",
            color: "#fde68a",
            fontWeight: 700
          }}
        >
          ⚠️ You appear to be off the selected route. SafeRoute will automatically calculate a new route to the destination.
        </div>
      )}


      {(rerouting || rerouteMessage) && (
        <div
          style={{
            marginTop: "8px",
            padding: "10px 12px",
            borderRadius: "10px",
            background: rerouting
              ? "rgba(59,130,246,0.18)"
              : rerouteMessage?.startsWith("✓")
                ? "rgba(34,197,94,0.18)"
                : "rgba(255,255,255,0.10)",
            color: "#e0f2fe",
            fontWeight: 700
          }}
        >
          {rerouting
            ? "🔄 Recalculating route..."
            : rerouteMessage}
        </div>
      )}

      <div
        style={{
          marginTop: "16px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(220px, 1fr)",
          gap: "12px"
        }}
      >
        <div
          style={{
            background: "rgba(255,255,255,0.1)",
            borderRadius: "14px",
            padding: "18px"
          }}
        >
          <div
            style={{
              fontSize: "0.85rem",
              opacity: 0.78,
              marginBottom: "7px"
            }}
          >
            {navigationActive ? "NEXT INSTRUCTION" : "FIRST INSTRUCTION"}
          </div>

          <div
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "center"
            }}
          >
            <div style={{ fontSize: "2.3rem" }}>
              {getNavigationTurnIcon(currentInstruction?.sign)}
            </div>

            <div>
              <div
                style={{
                  fontSize: "1.2rem",
                  fontWeight: 800,
                  lineHeight: 1.3
                }}
              >
                {!currentPosition
                  ? (currentInstruction?.text || "Waiting for GPS...")
                  : !isNearRoute
                    ? "Move toward the highlighted route"
                    : (currentInstruction?.text || "Continue on the selected route")}
              </div>

              <div
                style={{
                  marginTop: "6px",
                  fontSize: "0.95rem",
                  opacity: 0.82
                }}
              >
                {!currentPosition
                  ? "Waiting for your current location"
                  : !isNearRoute
                    ? `Route is ${formatNavigationDistance(nearestRoute.distance)} away`
                    : currentInstruction
                      ? `In ${formatNavigationDistance(distanceToNextTurn)}`
                      : "Continue toward the destination"}
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px"
          }}
        >
          <div
            style={{
              background: "rgba(255,255,255,0.1)",
              borderRadius: "12px",
              padding: "14px"
            }}
          >
            <div style={{ opacity: 0.72, fontSize: "0.8rem" }}>
              Remaining
            </div>
            <strong style={{ fontSize: "1.05rem" }}>
              {currentPosition && !isNearRoute
                ? "—"
                : formatNavigationDistance(remainingDistance)}
            </strong>
          </div>

          <div
            style={{
              background: "rgba(255,255,255,0.1)",
              borderRadius: "12px",
              padding: "14px"
            }}
          >
            <div style={{ opacity: 0.72, fontSize: "0.8rem" }}>
              ETA
            </div>
            <strong style={{ fontSize: "1.05rem" }}>
              {currentPosition && !isNearRoute
                ? "—"
                : formatNavigationTime(remainingMinutes)}
            </strong>
          </div>
        </div>
      </div>
      {currentPosition && navigationActive && (
        <div
          style={{
            marginTop: "10px",
            display: "flex",
            gap: "10px",
            flexWrap: "wrap",
            fontSize: "0.78rem",
            opacity: 0.86
          }}
        >
          <span>
            🧭 Direction {Math.round(Number(currentPosition.heading || 0))}°
          </span>
          {Number.isFinite(Number(currentPosition.speed)) &&
            Number(currentPosition.speed) >= 0 && (
              <span>
                🚶 Speed {(Number(currentPosition.speed) * 3.6).toFixed(1)} km/h
              </span>
            )}
          <span>
            📍 GPS ±{Math.round(Number(currentPosition.accuracy || 0))} m
          </span>
        </div>
      )}



      {instructions.length > 0 && (
        <details style={{ marginTop: "14px" }}>
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 700
            }}
          >
            Show turn-by-turn steps ({instructions.length})
          </summary>

          <div
            style={{
              marginTop: "10px",
              maxHeight: "260px",
              overflowY: "auto",
              paddingRight: "4px"
            }}
          >
            {instructions.map((instruction, index) => (
              <div
                key={`${index}-${instruction.text}`}
                style={{
                  display: "flex",
                  gap: "10px",
                  alignItems: "flex-start",
                  padding: "10px 0",
                  borderTop:
                    index === 0
                      ? "none"
                      : "1px solid rgba(255,255,255,0.12)",
                  opacity:
                    navigationActive && index < currentInstructionIndex
                      ? 0.45
                      : 1
                }}
              >
                <div style={{ fontSize: "1.2rem", width: "26px" }}>
                  {getNavigationTurnIcon(instruction.sign)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>
                    {instruction.text}
                  </div>
                  <div style={{ fontSize: "0.82rem", opacity: 0.72 }}>
                    {formatNavigationDistance(instruction.distance_m)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      <div
        style={{
          marginTop: "12px",
          fontSize: "0.78rem",
          opacity: 0.65
        }}
      >
        GPS guidance uses your browser's location permission. For best results, open the app on a phone over HTTPS.
      </div>
    </section>
  );
}

function RouteRatingPanel({ route, selectedRating, submitting, message, onSelectRating, onSubmit }) {
  if (!route?.route_key) return null;
  const average = Number(route.average_rating || 0);
  const count = Number(route.rating_count || 0);
  return (
    <div style={{ marginTop: "12px", padding: "14px", borderRadius: "12px", background: "#fffbeb", border: "1px solid #fde68a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
        <div><strong>⭐ User Route Rating</strong><div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "3px" }}>{count > 0 ? `${average.toFixed(1)}/5 from ${count} rating${count === 1 ? "" : "s"}` : "No ratings yet — your feedback will help future ranking."}</div></div>
        <div style={{ display: "flex", gap: "3px", alignItems: "center" }}>
          {[1,2,3,4,5].map((value) => <button key={value} type="button" onClick={() => onSelectRating(value)} style={{ border: "none", background: "transparent", fontSize: "1.45rem", cursor: "pointer", opacity: value <= Number(selectedRating) ? 1 : 0.3, padding: "2px" }}>★</button>)}
          <button type="button" onClick={onSubmit} disabled={submitting || !selectedRating} style={{ marginLeft: "6px", border: "none", borderRadius: "8px", padding: "8px 11px", background: submitting || !selectedRating ? "#cbd5e1" : "#d97706", color: "#fff", fontWeight: 800, cursor: submitting || !selectedRating ? "not-allowed" : "pointer" }}>{submitting ? "Saving..." : "Rate"}</button>
        </div>
      </div>
      {message && <div style={{ marginTop: "8px", fontSize: "0.8rem", fontWeight: 700, color: message.startsWith("✓") ? "#166534" : "#92400e" }}>{message}</div>}
    </div>
  );
}


function SelectedRouteMapController({ selectedRoute, navigationActive }) {
  const map = useMap();
  useEffect(() => {
    if (!selectedRoute || navigationActive) return;
    const coordinates = Array.isArray(selectedRoute.coordinates) ? selectedRoute.coordinates : [];
    if (!coordinates.length) return;
    const bounds = L.latLngBounds([]);
    coordinates.forEach((point) => {
      if (!Array.isArray(point) || point.length < 2) return;
      const lon = Number(point[0]); const lat = Number(point[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) bounds.extend([lat, lon]);
    });
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [35,35], maxZoom: 15, animate: true });
  }, [map, selectedRoute, navigationActive]);
  return null;
}


// ============================================================
// AUTOMATICALLY FIT MAP TO COMPLETE ROUTES
// ============================================================

function MapAutoFit({
  routes,
  sourceCoordinates,
  destinationCoordinates
}) {

  const map = useMap();

  useEffect(() => {

    // Leaflet sometimes calculates the map size before the section is
    // fully painted. Recalculate it before fitting the route.
    map.invalidateSize();

    const bounds = L.latLngBounds([]);

    // ALWAYS include the exact source and destination.
    // This guarantees both endpoint markers are inside the viewport.
    if (sourceCoordinates) {
      bounds.extend([
        Number(sourceCoordinates.latitude),
        Number(sourceCoordinates.longitude)
      ]);
    }

    if (destinationCoordinates) {
      bounds.extend([
        Number(destinationCoordinates.latitude),
        Number(destinationCoordinates.longitude)
      ]);
    }

    // Also include all returned route points.
    routes.forEach((route) => {
      const coordinates = Array.isArray(route?.coordinates)
        ? route.coordinates
        : [];

      coordinates.forEach((point) => {
        if (!Array.isArray(point) || point.length < 2) return;

        const longitude = Number(point[0]);
        const latitude = Number(point[1]);

        if (
          Number.isFinite(latitude) &&
          Number.isFinite(longitude)
        ) {
          bounds.extend([latitude, longitude]);
        }
      });
    });

    if (bounds.isValid()) {
      // Fit after a short delay as well so the final rendered map size
      // is used.
      map.fitBounds(bounds, {
        paddingTopLeft: [55, 55],
        paddingBottomRight: [55, 55],
        maxZoom: 9,
        animate: false
      });

      setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(bounds, {
          paddingTopLeft: [55, 55],
          paddingBottomRight: [55, 55],
          maxZoom: 9,
          animate: false
        });
      }, 150);
    }

  }, [
    map,
    routes,
    sourceCoordinates,
    destinationCoordinates
  ]);

  return null;
}



// ============================================================
// LIVE LOCATION VIEWER
// Opened when someone receives a SafeRoute live-location link.
// ============================================================

function LiveLocationViewer({ shareId }) {
  const [location, setLocation] = useState(null);
  const [status, setStatus] = useState("Connecting...");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!shareId) return undefined;

    let cancelled = false;

    const loadLocation = async () => {
      try {
        const response = await fetch(
          `http://127.0.0.1:8000/share/live/${encodeURIComponent(shareId)}`
        );
        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.message || "Live location is unavailable.");
        }

        if (!cancelled) {
          setLocation(data);
          setStatus(data.active ? "LIVE" : "Sharing ended");
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Unable to load live location.");
          setStatus("Unavailable");
        }
      }
    };

    loadLocation();
    const interval = window.setInterval(loadLocation, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [shareId]);

  const position = location?.latitude != null && location?.longitude != null
    ? [Number(location.latitude), Number(location.longitude)]
    : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#eef6ff",
        padding: "20px"
      }}
    >
      <div
        style={{
          maxWidth: "1100px",
          margin: "0 auto",
          background: "#ffffff",
          borderRadius: "20px",
          overflow: "hidden",
          boxShadow: "0 16px 40px rgba(15,23,42,0.15)"
        }}
      >
        <div
          style={{
            padding: "20px 24px",
            background: "linear-gradient(135deg, #0f172a, #1e3a8a)",
            color: "#ffffff"
          }}
        >
          <div style={{ fontSize: "0.78rem", opacity: 0.8 }}>
            SAFEROUTE LOCATION SHARING
          </div>
          <h1 style={{ margin: "4px 0 0" }}>
            🟢 Live Location
          </h1>
          <div style={{ marginTop: "8px", fontWeight: 800 }}>
            {status}
          </div>
        </div>

        {error && (
          <div
            style={{
              margin: "16px",
              padding: "12px",
              borderRadius: "10px",
              background: "#fee2e2",
              color: "#991b1b",
              fontWeight: 700
            }}
          >
            ⚠️ {error}
          </div>
        )}

        <div style={{ padding: "16px" }}>
          {position ? (
            <>
              <MapContainer
                center={position}
                zoom={16}
                style={{
                  height: "620px",
                  width: "100%",
                  borderRadius: "16px"
                }}
              >
                <TileLayer
                  attribution="Tiles © Esri"
                  url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                />
                <LiveLocationMapController position={position} />
                <CircleMarker
                  center={position}
                  radius={12}
                  pathOptions={{
                    color: "#ffffff",
                    weight: 4,
                    fillColor: "#16a34a",
                    fillOpacity: 1
                  }}
                >
                  <Popup>
                    <strong>🟢 Live location</strong>
                    <br />
                    Last update:{" "}
                    {location.updated_at
                      ? new Date(location.updated_at).toLocaleTimeString()
                      : "now"}
                  </Popup>
                </CircleMarker>
              </MapContainer>

              <div
                style={{
                  marginTop: "14px",
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: "10px"
                }}
              >
                <div
                  style={{
                    padding: "14px",
                    borderRadius: "12px",
                    background: "#f8fafc"
                  }}
                >
                  <div style={{ color: "#64748b", fontSize: "0.8rem" }}>
                    Latitude
                  </div>
                  <strong>{Number(location.latitude).toFixed(6)}</strong>
                </div>

                <div
                  style={{
                    padding: "14px",
                    borderRadius: "12px",
                    background: "#f8fafc"
                  }}
                >
                  <div style={{ color: "#64748b", fontSize: "0.8rem" }}>
                    Longitude
                  </div>
                  <strong>{Number(location.longitude).toFixed(6)}</strong>
                </div>

                <div
                  style={{
                    padding: "14px",
                    borderRadius: "12px",
                    background: "#f8fafc"
                  }}
                >
                  <div style={{ color: "#64748b", fontSize: "0.8rem" }}>
                    Last updated
                  </div>
                  <strong>
                    {location.updated_at
                      ? new Date(location.updated_at).toLocaleTimeString()
                      : "—"}
                  </strong>
                </div>
              </div>
            </>
          ) : (
            <div
              style={{
                padding: "70px 20px",
                textAlign: "center",
                color: "#64748b"
              }}
            >
              <div style={{ fontSize: "3rem" }}>📍</div>
              <h2>Waiting for location...</h2>
              <p>The SafeRoute user has not sent a GPS position yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveLocationMapController({ position }) {
  const map = useMap();

  useEffect(() => {
    if (position) {
      map.setView(position, Math.max(map.getZoom(), 16), {
        animate: true
      });
    }
  }, [map, position]);

  return null;
}

// ============================================================
// MAIN APP
// ============================================================

function App() {
  const liveShareId =
    new URLSearchParams(window.location.search).get("live");

  if (liveShareId) {
    return <LiveLocationViewer shareId={liveShareId} />;
  }

  return <SafeRouteMain />;
}

function SafeRouteMain() {
  const [source, setSource] = useState("");

  const [destination, setDestination] = useState("");

  const [routes, setRoutes] = useState([]);

  const [sourceCoordinates, setSourceCoordinates] =
    useState(null);

  const [destinationCoordinates, setDestinationCoordinates] =
    useState(null);

  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");

  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [showAllRoutes, setShowAllRoutes] = useState(true);
  const [traversedRouteIndex, setTraversedRouteIndex] = useState(0);
  const [ratingSelections, setRatingSelections] = useState({});
  const [ratingSubmitting, setRatingSubmitting] = useState({});
  const [ratingMessages, setRatingMessages] = useState({});
  const [moreRoutesLoading, setMoreRoutesLoading] = useState(false);
  const [moreRoutesMessage, setMoreRoutesMessage] = useState("");

  const [navigationActive, setNavigationActive] = useState(false);
  const [demoNavigationActive, setDemoNavigationActive] = useState(false);

  const [currentPosition, setCurrentPosition] = useState(null);

  const [currentInstructionIndex, setCurrentInstructionIndex] =
    useState(0);

  const [gpsError, setGpsError] = useState("");

  const [offRoute, setOffRoute] = useState(false);

  const [rerouting, setRerouting] = useState(false);
  const [rerouteMessage, setRerouteMessage] = useState("");
  const lastRerouteAtRef = useRef(0);

  const [liveSafety, setLiveSafety] = useState(null);

  const [liveSafetyLoading, setLiveSafetyLoading] = useState(false);

  const [liveSafetyError, setLiveSafetyError] = useState("");

  const [locationShareId, setLocationShareId] = useState("");
  const [locationShareUrl, setLocationShareUrl] = useState("");
  const [locationShareActive, setLocationShareActive] = useState(false);
  const [locationShareMessage, setLocationShareMessage] = useState("");

  const currentPositionRef = useRef(null);



  // ==========================================================
  // SET DEFAULT NAVIGATION ROUTE
  // ==========================================================

  useEffect(() => {
    if (!routes.length) {
      setSelectedRouteId(null);
      return;
    }

    // Do not reset an active navigation session when the route
    // geometry is updated by automatic rerouting.
    const selectedRouteStillExists =
      selectedRouteId != null &&
      routes.some(
        (route) =>
          Number(route?.route_id) ===
          Number(selectedRouteId)
      );

    if (selectedRouteStillExists) {
      return;
    }

    // Show the recommendation, but require the user to select the path.
    setSelectedRouteId(null);
    setTraversedRouteIndex(0);

    setNavigationActive(false);
    setDemoNavigationActive(false);
    setCurrentPosition(null);
    setCurrentInstructionIndex(0);
    setGpsError("");
    setOffRoute(false);
    setRerouting(false);
    setRerouteMessage("");
    lastRerouteAtRef.current = 0;
    setLiveSafety(null);
    setLiveSafetyError("");
  }, [routes, selectedRouteId]);


  // ==========================================================
  // LIVE GPS NAVIGATION
  // ==========================================================

  useEffect(() => {
    if (!navigationActive || demoNavigationActive) {
      return undefined;
    }

    if (!navigator.geolocation) {
      setGpsError("Geolocation is not supported by this browser.");
      return undefined;
    }

    setGpsError("");

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const previousPosition =
          currentPositionRef.current;

        const browserHeading =
          position.coords.heading;

        const heading =
          typeof browserHeading === "number" &&
          Number.isFinite(browserHeading)
            ? browserHeading
            : previousPosition
              ? calculateBearingDegrees(
                  previousPosition.latitude,
                  previousPosition.longitude,
                  position.coords.latitude,
                  position.coords.longitude
                )
              : 0;

        setCurrentPosition({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading,
          speed: position.coords.speed
        });
        setGpsError("");
      },
      (positionError) => {
        console.error("GPS error:", positionError);

        if (positionError.code === 1) {
          setGpsError(
            "Location permission was denied. Allow location access in your browser and try again."
          );
        } else if (positionError.code === 2) {
          setGpsError(
            "Your current location could not be determined. Try moving outdoors or enabling GPS."
          );
        } else {
          setGpsError(
            "GPS timed out. The browser will keep trying to obtain your location."
          );
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [navigationActive, demoNavigationActive]);


  // ==========================================================
  // DEMO NAVIGATION MODE
  // ==========================================================
  // Simulates GPS movement along the selected route for a college/demo
  // presentation. The normal browser GPS watcher is disabled while demo
  // mode is active, so real GPS cannot overwrite the simulated position.

  useEffect(() => {
    const demoRoute = routes.find(
      (route) => Number(route?.route_id) === Number(selectedRouteId)
    );

    if (!navigationActive || !demoNavigationActive || !demoRoute) {
      return undefined;
    }

    const coordinates = Array.isArray(demoRoute.coordinates)
      ? demoRoute.coordinates
      : [];

    if (coordinates.length < 2) {
      return undefined;
    }

    // Complete the whole route in 90 seconds for a convenient demo.
    const demoDurationMs = 90000;
    const startedAt = Date.now();

    const updateDemoPosition = () => {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(1, elapsed / demoDurationMs);
      const scaledIndex = progress * (coordinates.length - 1);
      const index = Math.min(coordinates.length - 1, Math.floor(scaledIndex));
      const nextIndex = Math.min(coordinates.length - 1, index + 1);
      const fraction = scaledIndex - index;

      const a = coordinates[index];
      const b = coordinates[nextIndex];

      if (!Array.isArray(a) || !Array.isArray(b)) return;

      const longitude =
        Number(a[0]) + (Number(b[0]) - Number(a[0])) * fraction;
      const latitude =
        Number(a[1]) + (Number(b[1]) - Number(a[1])) * fraction;
      const heading =
        calculateBearingDegrees(
          Number(a[1]),
          Number(a[0]),
          Number(b[1]),
          Number(b[0])
        );

      setCurrentPosition({
        latitude,
        longitude,
        accuracy: 5,
        heading,
        speed: null
      });

      if (progress >= 1) {
        setCurrentInstructionIndex(
          Math.max(0, (demoRoute.navigation_instructions || []).length - 1)
        );
        setDemoNavigationActive(false);
        setNavigationActive(false);
        setOffRoute(false);
        setGpsError("Demo navigation completed.");
      }
    };

    updateDemoPosition();
    const interval = window.setInterval(updateDemoPosition, 500);

    return () => {
      window.clearInterval(interval);
    };
  }, [navigationActive, demoNavigationActive, routes, selectedRouteId]);


  // ==========================================================
  // KEEP THE LATEST GPS POSITION FOR LIVE SAFETY POLLING
  // ==========================================================

  useEffect(() => {
    currentPositionRef.current = currentPosition;
  }, [currentPosition]);


  // ==========================================================
  // LIVE SAFETY MONITORING
  // ==========================================================
  // The phone position can change many times per second, so we do
  // NOT call the backend for every GPS update. Instead, SafeRoute
  // checks the current area immediately and then every 30 seconds.

  useEffect(() => {
    if (!navigationActive) {
      setLiveSafety(null);
      setLiveSafetyError("");
      setLiveSafetyLoading(false);
      return undefined;
    }

    let cancelled = false;

    const checkLiveSafety = async () => {
      const position = currentPositionRef.current;

      if (!position) return;

      const selectedRoute = routes.find(
        (route) => Number(route?.route_id) === Number(selectedRouteId)
      );
      const routeCoordinates = Array.isArray(selectedRoute?.coordinates)
        ? selectedRoute.coordinates
        : [];
      const nearest = getNearestRoutePointInfo(position, routeCoordinates);

      if (routeCoordinates.length > 0 && nearest.distance > 2000) {
        setLiveSafety(null);
        setLiveSafetyError(
          `Live safety will start when you are within 2 km of the selected route. Current distance: ${formatNavigationDistance(nearest.distance)}.`
        );
        setLiveSafetyLoading(false);
        return;
      }

      setLiveSafetyLoading(true);

      try {
        const response = await fetch("http://127.0.0.1:8000/live-safety", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            latitude: position.latitude,
            longitude: position.longitude
          })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.message || "Live safety check failed.");
        }

        if (!cancelled) {
          setLiveSafety(data);
          setLiveSafetyError("");
        }
      } catch (error) {
        console.error("Live safety error:", error);

        if (!cancelled) {
          setLiveSafetyError(
            "Live safety data is temporarily unavailable."
          );
        }
      } finally {
        if (!cancelled) {
          setLiveSafetyLoading(false);
        }
      }
    };

    const firstTimer = window.setTimeout(checkLiveSafety, 800);
    const interval = window.setInterval(checkLiveSafety, 30000);

    return () => {
      cancelled = true;
      window.clearTimeout(firstTimer);
      window.clearInterval(interval);
    };
  }, [navigationActive, routes, selectedRouteId]);


  // ==========================================================
  // UPDATE CURRENT TURN FROM GPS POSITION
  // ==========================================================

  useEffect(() => {
    const selectedRoute = routes.find(
      (route) => Number(route?.route_id) === Number(selectedRouteId)
    );

    if (!navigationActive || !currentPosition || !selectedRoute) {
      return;
    }

    const coordinates = Array.isArray(selectedRoute.coordinates)
      ? selectedRoute.coordinates
      : [];

    const instructions = Array.isArray(
      selectedRoute.navigation_instructions
    )
      ? selectedRoute.navigation_instructions
      : [];

    if (!coordinates.length || !instructions.length) {
      return;
    }

    const nearestRoute = getNearestRoutePointInfo(
      currentPosition,
      coordinates
    );
    const nearestPointIndex = nearestRoute.index;

    const nextInstructionIndex = getNavigationInstructionIndex(
      instructions,
      nearestPointIndex
    );

    setCurrentInstructionIndex((previousIndex) => {
      return Math.max(previousIndex, nextInstructionIndex);
    });

    setOffRoute(nearestRoute.distance > 120);
  }, [
    navigationActive,
    currentPosition,
    selectedRouteId,
    routes
  ]);


  // ==========================================================
  // TRAVELLED PATH HIGHLIGHT
  // ==========================================================

  useEffect(() => {
    const selected = routes.find((route) => Number(route?.route_id) === Number(selectedRouteId));
    if (!navigationActive || !currentPosition || !selected) {
      setTraversedRouteIndex(0);
      return;
    }
    const coordinates = Array.isArray(selected.coordinates) ? selected.coordinates : [];
    if (coordinates.length < 2) return;
    const nearest = getNearestRoutePointInfo(currentPosition, coordinates);
    setTraversedRouteIndex((previous) => Math.max(previous, nearest.index));
  }, [navigationActive, currentPosition, selectedRouteId, routes]);


  // ==========================================================
  // LOCATION SHARING
  // ==========================================================

  const shareCurrentLocation = async () => {
    if (!currentPosition) {
      setLocationShareMessage(
        "Start navigation or allow GPS access first so SafeRoute can read your current location."
      );
      return;
    }

    const latitude = Number(currentPosition.latitude).toFixed(6);
    const longitude = Number(currentPosition.longitude).toFixed(6);

    const mapUrl =
      `https://www.google.com/maps?q=${latitude},${longitude}`;

    const shareData = {
      title: "My SafeRoute current location",
      text: `📍 My current location: ${latitude}, ${longitude}`,
      url: mapUrl
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        setLocationShareMessage("Current location shared successfully.");
      } else {
        await navigator.clipboard.writeText(mapUrl);
        setLocationShareMessage(
          "Location link copied. Send it to your contact."
        );
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        try {
          await navigator.clipboard.writeText(mapUrl);
          setLocationShareMessage(
            "Location link copied. Send it to your contact."
          );
        } catch {
          setLocationShareMessage(mapUrl);
        }
      }
    }
  };

  const startLiveLocationSharing = async () => {
    if (!currentPosition) {
      setLocationShareMessage(
        "Start navigation and allow GPS access before sharing your live location."
      );
      return;
    }

    try {
      const response = await fetch(
        "http://127.0.0.1:8000/share/live/start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            latitude: currentPosition.latitude,
            longitude: currentPosition.longitude
          })
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.message || "Unable to start live location sharing."
        );
      }

      const url =
        `${window.location.origin}${window.location.pathname}?live=${encodeURIComponent(data.share_id)}`;

      setLocationShareId(data.share_id);
      setLocationShareUrl(url);
      setLocationShareActive(true);
      setLocationShareMessage(
        "Live location started. Share the link with your family or friend."
      );

      try {
        if (navigator.share) {
          await navigator.share({
            title: "SafeRoute Live Location",
            text: "🟢 Track my live SafeRoute location.",
            url
          });
        } else {
          await navigator.clipboard.writeText(url);
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          try {
            await navigator.clipboard.writeText(url);
          } catch {
            // The link remains visible in the UI.
          }
        }
      }
    } catch (error) {
      console.error("Live location start error:", error);
      setLocationShareMessage(
        error.message || "Could not start live location sharing."
      );
    }
  };

  const stopLiveLocationSharing = async () => {
    if (!locationShareId) return;

    try {
      await fetch(
        `http://127.0.0.1:8000/share/live/${encodeURIComponent(locationShareId)}/stop`,
        {
          method: "POST"
        }
      );
    } catch (error) {
      console.error("Live location stop error:", error);
    }

    setLocationShareActive(false);
    setLocationShareId("");
    setLocationShareUrl("");
    setLocationShareMessage("Live location sharing stopped.");
  };

  // Send fresh GPS coordinates to the live-location session.
  useEffect(() => {
    if (!locationShareActive || !locationShareId) {
      return undefined;
    }

    const pushLocation = async () => {
      const position = currentPositionRef.current;
      if (!position) return;

      try {
        await fetch(
          `http://127.0.0.1:8000/share/live/${encodeURIComponent(locationShareId)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              latitude: position.latitude,
              longitude: position.longitude,
              accuracy: position.accuracy || null
            })
          }
        );
      } catch (error) {
        console.error("Live location update error:", error);
      }
    };

    pushLocation();
    const interval = window.setInterval(pushLocation, 3000);

    return () => {
      window.clearInterval(interval);
    };
  }, [locationShareActive, locationShareId]);
  // ==========================================================
  // AUTOMATIC OFF-ROUTE REROUTING
  // ==========================================================

  useEffect(() => {
    if (
      !navigationActive ||
      demoNavigationActive ||
      !offRoute ||
      !currentPosition ||
      !destinationCoordinates ||
      rerouting
    ) {
      return undefined;
    }

    const selected = routes.find(
      (route) =>
        Number(route?.route_id) ===
        Number(selectedRouteId)
    );

    if (!selected) return undefined;

    const coordinates =
      Array.isArray(selected.coordinates)
        ? selected.coordinates
        : [];

    const nearest =
      getNearestRoutePointInfo(
        currentPosition,
        coordinates
      );

    if (nearest.distance < 200) {
      return undefined;
    }

    const now = Date.now();

    if (now - lastRerouteAtRef.current < 15000) {
      return undefined;
    }

    lastRerouteAtRef.current = now;
    let cancelled = false;

    const performReroute = async () => {
      setRerouting(true);
      setRerouteMessage(
        "🔄 You are off route. Calculating a new route..."
      );

      try {
        const response = await fetch(
          "http://127.0.0.1:8000/reroute",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              latitude: currentPosition.latitude,
              longitude: currentPosition.longitude,
              destination_latitude:
                destinationCoordinates.latitude,
              destination_longitude:
                destinationCoordinates.longitude
            })
          }
        );

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(
            data.message ||
              "Unable to calculate a new route."
          );
        }

        const freshRoute = data.route;

        if (
          !freshRoute ||
          !Array.isArray(freshRoute.coordinates) ||
          freshRoute.coordinates.length < 2
        ) {
          throw new Error(
            "The backend returned an invalid reroute."
          );
        }

        if (!cancelled) {
          setRoutes((previousRoutes) =>
            previousRoutes.map((route) =>
              Number(route?.route_id) ===
              Number(selectedRouteId)
                ? {
                    ...route,
                    ...freshRoute,
                    rerouted: true,
                    rerouted_from_position: {
                      latitude:
                        currentPosition.latitude,
                      longitude:
                        currentPosition.longitude
                    }
                  }
                : route
            )
          );

          setCurrentInstructionIndex(0);
          setOffRoute(false);
          setRerouteMessage(
            "✓ New route calculated. Navigation is continuing to the destination."
          );
        }
      } catch (error) {
        console.error(
          "Automatic reroute error:",
          error
        );

        if (!cancelled) {
          setRerouteMessage(
            "⚠️ Automatic rerouting is temporarily unavailable. Move back toward the highlighted route."
          );
        }
      } finally {
        if (!cancelled) {
          setRerouting(false);
        }
      }
    };

    performReroute();

    return () => {
      cancelled = true;
    };
  }, [
    navigationActive,
    demoNavigationActive,
    offRoute,
    currentPosition,
    destinationCoordinates,
    selectedRouteId,
    routes,
    rerouting
  ]);




  // ==========================================================
  // START NAVIGATION
  // ==========================================================

  const startNavigation = () => {
    if (!selectedRoute) return;

    setGpsError("");
    setOffRoute(false);
    setRerouting(false);
    setRerouteMessage("");
    lastRerouteAtRef.current = 0;
    setCurrentInstructionIndex(0);
    setDemoNavigationActive(false);
    setNavigationActive(true);
  };


  const startDemoNavigation = () => {
    if (!selectedRoute) return;

    setGpsError("");
    setOffRoute(false);
    setRerouting(false);
    setRerouteMessage("");
    lastRerouteAtRef.current = 0;
    setCurrentInstructionIndex(0);
    setDemoNavigationActive(true);
    setNavigationActive(true);
  };


  const stopNavigation = async () => {
    if (locationShareActive && locationShareId) {
      try {
        await fetch(
          `http://127.0.0.1:8000/share/live/${encodeURIComponent(locationShareId)}/stop`,
          { method: "POST" }
        );
      } catch (error) {
        console.error("Live location stop error:", error);
      }
    }

    setLocationShareActive(false);
    setLocationShareId("");
    setLocationShareUrl("");
    setLocationShareMessage("");

    setNavigationActive(false);
    setDemoNavigationActive(false);
    setCurrentPosition(null);
    setOffRoute(false);
    setRerouting(false);
    setRerouteMessage("");
    lastRerouteAtRef.current = 0;
    setLiveSafety(null);
    setLiveSafetyError("");
  };


  const recenterNavigation = () => {
    window.dispatchEvent(
      new CustomEvent("saferoute-recenter")
    );
  };


  // ==========================================================
  // MANUAL ROUTE SELECTION
  // ==========================================================

  const selectRouteForNavigation = (routeId) => {
    setSelectedRouteId(routeId);
    setShowAllRoutes(false);
    setCurrentInstructionIndex(0);
    setTraversedRouteIndex(0);
    setGpsError("");
    setOffRoute(false);
    setRerouting(false);
    setRerouteMessage("");
    setNavigationActive(false);
    setDemoNavigationActive(false);
    setCurrentPosition(null);
  };


  // ==========================================================
  // ROUTE RATING
  // ==========================================================

  const submitRouteRating = async (route) => {
    const routeKey = route?.route_key;
    const rating = Number(ratingSelections[routeKey] || 0);
    if (!routeKey) return;
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      setRatingMessages((previous) => ({ ...previous, [routeKey]: "Please select 1–5 stars." }));
      return;
    }
    setRatingSubmitting((previous) => ({ ...previous, [routeKey]: true }));
    try {
      const response = await fetch("http://127.0.0.1:8000/rate-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route_key: routeKey, rating, source, destination })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Rating failed.");
      setRoutes((previous) => previous.map((item) => item.route_key === routeKey ? { ...item, average_rating: data.average_rating, rating_count: data.rating_count, rating_score: data.rating_score } : item));
      setRatingMessages((previous) => ({ ...previous, [routeKey]: `✓ Saved. Average ${Number(data.average_rating).toFixed(1)}/5` }));
    } catch (error) {
      setRatingMessages((previous) => ({ ...previous, [routeKey]: error.message || "Could not save rating." }));
    } finally {
      setRatingSubmitting((previous) => ({ ...previous, [routeKey]: false }));
    }
  };


  // ==========================================================
  // FIND MORE ROUTES (UP TO 10)
  // ==========================================================

  const findMoreRoutes = async () => {
    if (!source.trim() || !destination.trim() || routes.length >= 10) return;
    setMoreRoutesLoading(true);
    setMoreRoutesMessage("");
    try {
      const excludedRouteKeys = routes.map((route) => route?.route_key).filter(Boolean);
      const response = await fetch("http://127.0.0.1:8000/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, destination, max_routes: 10, excluded_route_keys: excludedRouteKeys })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not generate more routes.");
      const existing = new Set(excludedRouteKeys);
      const fresh = (data.routes || []).filter((route) => route?.route_key && !existing.has(route.route_key));
      setRoutes((previous) => {
        const all = [...previous, ...fresh];
        const seen = new Set();
        const unique = all.filter((route) => {
          const key = route?.route_key || `id-${route?.route_id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        unique.sort((a, b) => Number(b?.ranking_score ?? b?.safety_score ?? 0) - Number(a?.ranking_score ?? a?.safety_score ?? 0));

        // Preserve existing route IDs so an actively selected route does not
        // jump to another route when more alternatives are added.
        const usedIds = new Set();
        let nextId = Math.max(0, ...previous.map((route) => Number(route?.route_id) || 0)) + 1;
        const withIds = unique.slice(0, 10).map((route) => {
          let routeId = Number(route?.route_id);
          if (!Number.isFinite(routeId) || routeId < 1 || usedIds.has(routeId)) {
            routeId = nextId;
            nextId += 1;
          }
          usedIds.add(routeId);
          return { ...route, route_id: routeId };
        });

        return withIds.map((route, index) => ({
          ...route,
          safety_rank: index + 1,
          recommended: index === 0
        }));
      });
      setMoreRoutesMessage(fresh.length > 0 ? `✓ Added ${fresh.length} new route${fresh.length === 1 ? "" : "s"}.` : "No additional distinct road routes are available for this journey.");
    } catch (error) {
      setMoreRoutesMessage(error.message || "Could not generate more routes.");
    } finally {
      setMoreRoutesLoading(false);
    }
  };


  // ==========================================================
  // FIND ROUTES
  // ==========================================================

  const findRoutes = async () => {

    if (!source.trim()) {
      setError("Please enter a source location.");
      return;
    }

    if (!destination.trim()) {
      setError("Please enter a destination location.");
      return;
    }

    setLoading(true);
    setError("");
    setSelectedRouteId(null);
    setShowAllRoutes(true);
    setRoutes([]);
    setNavigationActive(false);
    setDemoNavigationActive(false);
    setCurrentPosition(null);
    setOffRoute(false);
     setRerouting(false);
     setRerouteMessage("");
     lastRerouteAtRef.current = 0;
    setGpsError("");

    try {

      const response = await fetch(
        "http://127.0.0.1:8000/routes",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            source: source,
            destination: destination,
            max_routes: 10,
            excluded_route_keys: []
          })
        }
      );


      const data = await response.json();


      if (!response.ok) {
        throw new Error(
          data.message ||
          "Unable to find routes."
        );
      }


      if (!data.success) {
        throw new Error(
          data.message ||
          "Unable to find routes."
        );
      }


      setRoutes(
        data.routes || []
      );


      setSourceCoordinates(
        data.source_coordinates || null
      );


      setDestinationCoordinates(
        data.destination_coordinates || null
      );


    } catch (err) {

      console.error(
        "Route request error:",
        err
      );

      setError(
        err.message ||
        "Could not connect to backend."
      );

    } finally {

      setLoading(false);

    }
  };


  // ==========================================================
  // ENTER KEY SUPPORT
  // ==========================================================

  const handleKeyDown = (event) => {

    if (event.key === "Enter") {
      findRoutes();
    }

  };


  // ==========================================================
  // MAP CENTER
  // ==========================================================

  // Initial map view only. Once routes are loaded,
  // MapAutoFit automatically fits the complete route journey.
  let mapCenter = [15.9129, 79.7400];
  let mapZoom = 7;


  // ==========================================================
  // CONVERT GRAPH HOPPER COORDINATES
  // ==========================================================

  const convertCoordinates = (coordinates) => {

    if (!coordinates) {
      return [];
    }

    return coordinates.map(
      ([longitude, latitude]) => [
        latitude,
        longitude
      ]
    );

  };


  const selectedRoute = routes.find(
    (route) => Number(route?.route_id) === Number(selectedRouteId)
  ) || null;


  // ==========================================================
  // RENDER
  // ==========================================================

  return (

    <div className="app-container">

      {/* ====================================================
          HEADER
      ==================================================== */}

      <header className="app-header">

        <div>

          <h1>
            🛡️ Safe Route Finder
          </h1>

          <p>
            Find safer routes using traffic, nighttime
            lighting, live weather and crime data
          </p>

        </div>

      </header>


      {/* ====================================================
          SEARCH SECTION
      ==================================================== */}

      <section className="search-section">

        <div className="input-group">

          <label>
            Source
          </label>

          <input
            type="text"
            placeholder="Enter source location"
            value={source}
            onChange={(event) =>
              setSource(event.target.value)
            }
            onKeyDown={handleKeyDown}
          />

        </div>


        <div className="input-group">

          <label>
            Destination
          </label>

          <input
            type="text"
            placeholder="Enter destination location"
            value={destination}
            onChange={(event) =>
              setDestination(event.target.value)
            }
            onKeyDown={handleKeyDown}
          />

        </div>


        <button
          className="find-button"
          onClick={findRoutes}
          disabled={loading}
        >

          {loading
            ? "Finding Routes..."
            : "Find Safe Routes"
          }

        </button>

      </section>


      {/* ====================================================
          ERROR
      ==================================================== */}

      {error && (

        <div className="error-message">

          ❌ {error}

        </div>

      )}


      <NavigationPanel
        selectedRoute={selectedRoute}
        navigationActive={navigationActive}
        currentPosition={currentPosition}
        currentInstructionIndex={currentInstructionIndex}
        onStart={startNavigation}
        onDemoStart={startDemoNavigation}
        onStop={stopNavigation}
        onRecenter={recenterNavigation}
        gpsError={gpsError}
        offRoute={offRoute}
        rerouting={rerouting}
        rerouteMessage={rerouteMessage}
        onShareCurrent={shareCurrentLocation}
        onStartLiveShare={startLiveLocationSharing}
        onStopLiveShare={stopLiveLocationSharing}
        locationShareActive={locationShareActive}
        locationShareUrl={locationShareUrl}
        locationShareMessage={locationShareMessage}
        demoNavigationActive={demoNavigationActive}
      />

      <LiveSafetyPanel
        liveSafety={liveSafety}
        loading={liveSafetyLoading}
        error={liveSafetyError}
      />


      {/* ====================================================
          MAP
      ==================================================== */}

      <section className="map-section">

        <MapContainer
          center={mapCenter}
          zoom={mapZoom}
          style={{
            height: "500px",
            width: "100%"
          }}
        >

          <TileLayer
            attribution="Tiles © Esri"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          />

          <MapAutoFit
            routes={routes}
            sourceCoordinates={sourceCoordinates}
            destinationCoordinates={destinationCoordinates}
          />

          <NavigationMapController
            navigationActive={navigationActive}
            currentPosition={currentPosition}
          />

          <SelectedRouteMapController
            selectedRoute={selectedRoute}
            navigationActive={navigationActive}
          />


          {/* SOURCE MARKER */}

          {sourceCoordinates && (

            <Marker
              position={[
                sourceCoordinates.latitude,
                sourceCoordinates.longitude
              ]}
            >

              <Popup>

                <strong>
                  Source
                </strong>

                <br />

                {source}

              </Popup>

            </Marker>

          )}


          {/* DESTINATION MARKER */}

          {destinationCoordinates && (

            <Marker
              position={[
                destinationCoordinates.latitude,
                destinationCoordinates.longitude
              ]}
            >

              <Popup>

                <strong>
                  Destination
                </strong>

                <br />

                {destination}

              </Popup>

            </Marker>

          )}
          {currentPosition && navigationActive && (
            <>
              <CircleMarker
                center={[
                  currentPosition.latitude,
                  currentPosition.longitude
                ]}
                radius={Math.min(
                  35,
                  Math.max(
                    12,
                    Number(currentPosition.accuracy || 12) / 2
                  )
                )}
                pathOptions={{
                  color: "#60a5fa",
                  weight: 2,
                  fillColor: "#60a5fa",
                  fillOpacity: 0.12
                }}
              />

              <MovingLocationPointer
                position={currentPosition}
                heading={currentPosition.heading || 0}
                popupText={
                  demoNavigationActive
                    ? "Demo moving position"
                    : "Your current location"
                }
              />
            </>
          )}


          {/* ROUTES */}

          {[...routes]
            // Once the user selects a path, show only that path on the map.
            .filter((route) =>
              showAllRoutes || Number(route?.route_id) === Number(selectedRouteId)
            )
            // Draw alternatives first and the recommended route last.
            .sort(
              (a, b) =>
                Number(a?.recommended === true) -
                Number(b?.recommended === true)
            )
            .map((route, index) => {

              const routeCoordinates =
                convertCoordinates(route.coordinates);

              const isRecommended =
                route?.recommended === true ||
                Number(route?.safety_rank) === 1;

              const routeColor = getRouteColor(route);
              const routeId = Number(route?.route_id);
              const isSelected =
                Number(route?.route_id) === Number(selectedRouteId);

              // Different line patterns help distinguish routes that share
              // the same physical road segment.
              let dashArray;
              if (!isRecommended) {
                if (routeId === 2) {
                  dashArray = "16 10";
                } else if (routeId === 3) {
                  dashArray = "5 9";
                } else {
                  dashArray = undefined;
                }
              }

              return (
                <Fragment key={route?.route_id ?? `route-${index}`}>
                  {/* White casing separates colored routes from the satellite image. */}
                  <Polyline
                    positions={routeCoordinates}
                    pathOptions={{
                      color: "#ffffff",
                      weight: isSelected ? 13 : isRecommended ? 11 : 8,
                      opacity: isSelected ? 1 : 0.92,
                      lineCap: "round",
                      lineJoin: "round"
                    }}
                  />

                  <Polyline
                    positions={routeCoordinates}
                    pathOptions={{
                      color: routeColor,
                      weight: isSelected ? 8 : isRecommended ? 7 : 5,
                      opacity: isSelected ? 1 : isRecommended ? 1 : 0.72,
                      dashArray,
                      lineCap: "round",
                      lineJoin: "round"
                    }}
                  />

                  {isSelected && navigationActive && traversedRouteIndex > 0 && (
                    <Polyline
                      positions={[
                        ...routeCoordinates.slice(0, traversedRouteIndex + 1),
                        ...(currentPosition ? [[currentPosition.latitude, currentPosition.longitude]] : [])
                      ]}
                      pathOptions={{
                        color: "#93c5fd",
                        weight: 9,
                        opacity: 0.95,
                        lineCap: "round",
                        lineJoin: "round"
                      }}
                    />
                  )}
                </Fragment>
              );

            })}


        </MapContainer>

      </section>


      {/* ====================================================
          MAP LEGEND
      ==================================================== */}

      {routes.length > 0 && (

        <div
          className="route-legend"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
            alignItems: "center",
            padding: "12px 16px",
            marginTop: "10px",
            marginBottom: "20px",
            background: "#ffffff",
            borderRadius: "12px",
            boxShadow: "0 4px 14px rgba(0,0,0,0.08)"
          }}
        >

          <strong>Map Legend:</strong>

          {routes
            .slice()
            .sort(
              (a, b) =>
                Number(a?.route_id || 0) -
                Number(b?.route_id || 0)
            )
            .map((route) => (

              <div
                key={`legend-${route?.route_id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "7px"
                }}
              >

                <span
                  style={{
                    display: "inline-block",
                    width: "28px",
                    height: "5px",
                    borderRadius: "5px",
                    backgroundColor: getRouteColor(route)
                  }}
                />

                <span>
                  Route {route?.route_id}
                  {route?.recommended === true
                    ? " — Recommended"
                    : ""}
                </span>

              </div>

            ))}

          <span
            style={{
              fontSize: "13px",
              color: "#64748b"
            }}
          >
            Shared road sections may overlap.
          </span>

        </div>

      )}


      {/* ====================================================
          ROUTE RESULTS
      ==================================================== */}

      {routes.length > 0 && (

        <section className="routes-section">

          <h2>
            🛣️ Route Options
          </h2>


          <p className="route-summary">

            {showAllRoutes
              ? `Found ${routes.length} route${routes.length !== 1 ? "s" : ""}. Select the path you want to travel.`
              : `Route ${selectedRouteId} selected. Other routes are hidden while you travel.`}

          </p>

          {selectedRouteId != null && !showAllRoutes && (
            <div
              style={{
                margin: "12px 0 18px",
                padding: "12px 15px",
                borderRadius: "12px",
                background: "#ecfdf5",
                border: "1px solid #bbf7d0",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                flexWrap: "wrap"
              }}
            >
              <div>
                <strong>✓ Selected path: Route {selectedRouteId}</strong>
                <div style={{ fontSize: "0.82rem", color: "#475569", marginTop: "3px" }}>
                  The map is focused on your selected path. The travelled section becomes light blue as you move.
                </div>
              </div>
              <button
                onClick={() => setShowAllRoutes(true)}
                style={{
                  border: "none",
                  borderRadius: "9px",
                  padding: "10px 14px",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontWeight: 800,
                  cursor: "pointer"
                }}
              >
                ⇄ Change Path / Show All Routes
              </button>
            </div>
          )}

          <div style={{ margin: "12px 0 18px", padding: "13px 15px", borderRadius: "12px", background: "#eff6ff", border: "1px solid #bfdbfe", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <div>
              <strong>Not satisfied with these routes?</strong>
              <div style={{ fontSize: "0.82rem", color: "#475569", marginTop: "3px" }}>Search for more distinct road paths, up to 10 routes.</div>
            </div>
            <button onClick={findMoreRoutes} disabled={moreRoutesLoading || routes.length >= 10} style={{ border: "none", borderRadius: "9px", padding: "10px 14px", background: routes.length >= 10 ? "#cbd5e1" : "#2563eb", color: "#ffffff", fontWeight: 800, cursor: moreRoutesLoading || routes.length >= 10 ? "not-allowed" : "pointer" }}>
              {moreRoutesLoading ? "Searching..." : routes.length >= 10 ? "10 Routes Reached" : "↻ Find More Routes"}
            </button>
          </div>

          {moreRoutesMessage && (
            <div style={{ marginBottom: "14px", padding: "10px 12px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0", color: "#334155", fontWeight: 700 }}>{moreRoutesMessage}</div>
          )}


          {routes
            .filter((route) =>
              showAllRoutes || Number(route?.route_id) === Number(selectedRouteId)
            )
            .map(
              (route, index) => {

              const lightingScore =
                Number(
                  route.lighting_score ?? 0
                );


              const trafficScore =
                Number(
                  route.traffic_score ?? 0
                );


              const weatherScore =
                Number(
                  route.weather_score ?? 0
                );


              const crimeRiskScore =
                Number(
                  route.crime_risk_score ?? 0
                );


              const crimeSafetyScore =
                Number(
                  route.crime_safety_score ?? 0
                );


              const safetyScore = Math.max(
                0,
                Math.min(
                  100,
                  Number(
                    route.safety_score ??
                    route.final_safety_score ??
                    route.ai_safety_score ??
                    0
                  )
                )
              );

              const safetyRiskLevel =
                route.risk_level ||
                route.safety_risk_level ||
                getSafetyRisk(safetyScore);

              const safetyRank =
                route.safety_rank ??
                (index + 1);

              const isRecommended =
                route.recommended === true ||
                Number(safetyRank) === 1;


              return (

                <div
                  className="route-card"
                  key={
                    route.route_id ||
                    index
                  }
                >


                  {/* ==========================================
                      ROUTE HEADER
                  ========================================== */}

                  <div className="route-header">

                    <div>

                      <h2>

                        <span
                          className="route-color"
                          style={{
                            backgroundColor:
                              getRouteColor(route)
                          }}
                        />

                        Route {route.route_id}

                      </h2>

                    </div>


                    <div className="route-basic-info">

                      <div>

                        <span>
                          Distance
                        </span>

                        <strong>
                          {route.distance_km} km
                        </strong>

                      </div>


                      <div>

                        <span>
                          Travel Time
                        </span>

                        <strong>
                          {route.time_minutes} min
                        </strong>

                      </div>

                      <div style={{ alignSelf: "center" }}>
                        <button
                          onClick={() => selectRouteForNavigation(route.route_id)}
                          style={{
                            border: "none",
                            borderRadius: "9px",
                            padding: "9px 12px",
                            background:
                              Number(selectedRouteId) === Number(route.route_id)
                                ? "#2563eb"
                                : "#e2e8f0",
                            color:
                              Number(selectedRouteId) === Number(route.route_id)
                                ? "#ffffff"
                                : "#0f172a",
                            fontWeight: 700,
                            cursor: "pointer"
                          }}
                        >
                          {Number(selectedRouteId) === Number(route.route_id)
                            ? "✓ Selected Path"
                            : "Select This Path"}
                        </button>
                      </div>

                    </div>

                  </div>

                  <RouteRatingPanel
                    route={route}
                    selectedRating={ratingSelections[route.route_key] || 0}
                    submitting={Boolean(ratingSubmitting[route.route_key])}
                    message={ratingMessages[route.route_key] || ""}
                    onSelectRating={(value) =>
                      setRatingSelections((previous) => ({ ...previous, [route.route_key]: value }))
                    }
                    onSubmit={() => submitRouteRating(route)}
                  />


                  {/* ==========================================
                      NASA NIGHTTIME LIGHTING
                  ========================================== */}

                  <div className="info-section lighting-section">

                    <h3>
                      🌙 Nighttime Lighting
                    </h3>


                    <div className="info-grid">

                      <div className="info-item">

                        <span>
                          Lighting Score
                        </span>

                        <strong>
                          {lightingScore} / 100
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Visibility Level
                        </span>

                        <strong>
                          {getLightingCondition(
                            lightingScore
                          )}
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          NASA Lighting Samples
                        </span>

                        <strong>
                          {
                            route.lighting_sample_count ??
                            0
                          }
                        </strong>

                      </div>

                    </div>


                    <p className="data-source">

                      Lighting data source:
                      NASA VIIRS Nighttime Lights

                    </p>

                  </div>


                  {/* ==========================================
                      TOMTOM TRAFFIC
                  ========================================== */}

                  <div className="info-section traffic-section">

                    <h3>
                      🚗 Real-Time Traffic
                    </h3>


                    <div className="info-grid">

                      <div className="info-item">

                        <span>
                          Traffic Condition
                        </span>

                        <strong>
                          {getTrafficCondition(
                            trafficScore
                          )}
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Traffic Score
                        </span>

                        <strong>
                          {trafficScore} / 100
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Current Speed
                        </span>

                        <strong>
                          {
                            route.average_current_speed_kmph ??
                            0
                          }{" "}
                          km/h
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Free-Flow Speed
                        </span>

                        <strong>
                          {
                            route.average_free_flow_speed_kmph ??
                            0
                          }{" "}
                          km/h
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Traffic Delay
                        </span>

                        <strong>
                          {
                            route.average_delay_seconds ??
                            0
                          }{" "}
                          seconds
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Speed Ratio
                        </span>

                        <strong>
                          {(
                            Number(
                              route.average_speed_ratio ??
                              0
                            ) * 100
                          ).toFixed(1)}
                          %
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Traffic Confidence
                        </span>

                        <strong>
                          {(
                            Number(
                              route.traffic_confidence ??
                              0
                            ) * 100
                          ).toFixed(1)}
                          %
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Traffic Samples
                        </span>

                        <strong>
                          {
                            route.traffic_sample_count ??
                            0
                          }
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Road Closures
                        </span>

                        <strong>
                          {
                            route.road_closure_count ??
                            0
                          }
                        </strong>

                      </div>

                    </div>


                    <p className="data-source">

                      Traffic data source:
                      TomTom Traffic API

                    </p>

                  </div>


                  {/* ==========================================
                      OPEN-METEO WEATHER
                  ========================================== */}

                  <div className="info-section weather-section">

                    <h3>
                      🌦️ Live Weather
                    </h3>


                    <div className="weather-highlight">

                      <div>

                        <span>
                          Weather Condition
                        </span>

                        <strong>
                          {
                            route.weather_condition ||
                            "Unavailable"
                          }
                        </strong>

                      </div>


                      <div>

                        <span>
                          Weather Risk
                        </span>

                        <strong>
                          {getWeatherRisk(
                            weatherScore
                          )}
                        </strong>

                      </div>


                      <div>

                        <span>
                          Weather Score
                        </span>

                        <strong>
                          {weatherScore} / 100
                        </strong>

                      </div>

                    </div>


                    <div className="info-grid">

                      <div className="info-item">

                        <span>
                          Temperature
                        </span>

                        <strong>
                          {
                            route.average_temperature_c ??
                            0
                          }{" "}
                          °C
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Humidity
                        </span>

                        <strong>
                          {
                            route.average_humidity_percent ??
                            0
                          }{" "}
                          %
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Rain
                        </span>

                        <strong>
                          {
                            route.average_rain_mm ??
                            0
                          }{" "}
                          mm
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Precipitation
                        </span>

                        <strong>
                          {
                            route.average_precipitation_mm ??
                            0
                          }{" "}
                          mm
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Wind Speed
                        </span>

                        <strong>
                          {
                            route.average_wind_speed_kmph ??
                            0
                          }{" "}
                          km/h
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Wind Gusts
                        </span>

                        <strong>
                          {
                            route.average_wind_gusts_kmph ??
                            0
                          }{" "}
                          km/h
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Cloud Cover
                        </span>

                        <strong>
                          {
                            route.average_cloud_cover_percent ??
                            0
                          }{" "}
                          %
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Weather Samples
                        </span>

                        <strong>
                          {
                            route.weather_sample_count ??
                            0
                          }
                        </strong>

                      </div>

                    </div>


                    <p className="data-source">

                      Weather data source:
                      Open-Meteo

                    </p>

                  </div>


                  {/* ==========================================
                      CRIME DATA
                  ========================================== */}

                  <div className="info-section crime-section">

                    <h3>
                      🔴 Crime & Safety
                    </h3>


                    <div className="weather-highlight">

                      <div>

                        <span>
                          Crime Risk
                        </span>

                        <strong>
                          {crimeRiskScore} / 100
                        </strong>

                      </div>


                      <div>

                        <span>
                          Crime Safety
                        </span>

                        <strong>
                          {crimeSafetyScore} / 100
                        </strong>

                      </div>


                      <div>

                        <span>
                          Risk Level
                        </span>

                        <strong>
                          {getCrimeRisk(
                            crimeRiskScore
                          )}
                        </strong>

                      </div>

                    </div>


                    <div className="info-grid">

                      <div className="info-item">

                        <span>
                          Main Location
                        </span>

                        <strong>
                          {
                            route.crime_location ||
                            "Unknown"
                          }
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Location Type
                        </span>

                        <strong>
                          {
                            route.crime_location_type ||
                            "Unknown"
                          }
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Crime Samples
                        </span>

                        <strong>
                          {
                            route.crime_sample_count ??
                            0
                          }
                        </strong>

                      </div>


                      <div className="info-item">

                        <span>
                          Locations Covered
                        </span>

                        <strong>
                          {
                            route.crime_locations?.length ??
                            0
                          }
                        </strong>

                      </div>

                    </div>


                    {route.crime_locations &&
                      route.crime_locations.length > 0 && (

                        <p className="data-source">

                          Areas analyzed:{" "}
                          {route.crime_locations.join(
                            ", "
                          )}

                        </p>

                      )}


                    <p className="data-source">

                      Crime data:
                      {
                        route.crime_data_type ===
                        "includes_estimated_data"
                          ? " Includes estimated 2026 project data"
                          : " Project crime dataset"
                      }

                    </p>

                  </div>


                  {/* ==========================================
                      FINAL AI SAFETY PREDICTION
                  ========================================== */}

                  <div
                    className="info-section"
                    style={{
                      marginTop: "24px",
                      padding: "24px",
                      borderRadius: "18px",
                      background:
                        "linear-gradient(135deg, #eef2ff 0%, #f5f3ff 50%, #ecfeff 100%)",
                      border: isRecommended
                        ? "2px solid #16a34a"
                        : "2px solid #6366f1",
                      boxShadow:
                        "0 8px 24px rgba(79, 70, 229, 0.12)"
                    }}
                  >

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "16px",
                        flexWrap: "wrap",
                        marginBottom: "18px"
                      }}
                    >

                      <div>
                        <h3
                          style={{
                            margin: 0,
                            color: "#312e81",
                            fontSize: "1.25rem"
                          }}
                        >
                          🧠 Final AI Safety Prediction
                        </h3>

                        <p
                          style={{
                            margin: "6px 0 0",
                            color: "#4b5563"
                          }}
                        >
                          SafeRoute V1 multi-branch deep-learning model
                        </p>
                      </div>

                      {isRecommended && (
                        <div
                          style={{
                            padding: "8px 14px",
                            borderRadius: "999px",
                            background: "#dcfce7",
                            color: "#166534",
                            fontWeight: 800,
                            fontSize: "0.9rem"
                          }}
                        >
                          🏆 RECOMMENDED ROUTE
                        </div>
                      )}

                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(180px, 1fr))",
                        gap: "16px",
                        marginBottom: "18px"
                      }}
                    >

                      <div
                        style={{
                          padding: "18px",
                          borderRadius: "14px",
                          background: "#ffffff",
                          textAlign: "center",
                          border: "1px solid #c7d2fe"
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            color: "#6b7280",
                            fontSize: "0.9rem",
                            marginBottom: "7px"
                          }}
                        >
                          AI Safety Score
                        </span>

                        <strong
                          style={{
                            display: "block",
                            color: "#312e81",
                            fontSize: "2rem",
                            lineHeight: 1.1
                          }}
                        >
                          {safetyScore.toFixed(2)} / 100
                        </strong>
                      </div>

                      <div
                        style={{
                          padding: "18px",
                          borderRadius: "14px",
                          background: "#ffffff",
                          textAlign: "center",
                          border: "1px solid #c7d2fe"
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            color: "#6b7280",
                            fontSize: "0.9rem",
                            marginBottom: "7px"
                          }}
                        >
                          AI Risk Level
                        </span>

                        <strong
                          style={{
                            display: "block",
                            color: "#4338ca",
                            fontSize: "1.25rem"
                          }}
                        >
                          {safetyRiskLevel}
                        </strong>
                      </div>

                      <div
                        style={{
                          padding: "18px",
                          borderRadius: "14px",
                          background: "#ffffff",
                          textAlign: "center",
                          border: "1px solid #c7d2fe"
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            color: "#6b7280",
                            fontSize: "0.9rem",
                            marginBottom: "7px"
                          }}
                        >
                          Safety Rank
                        </span>

                        <strong
                          style={{
                            display: "block",
                            color: "#312e81",
                            fontSize: "1.5rem"
                          }}
                        >
                          #{safetyRank}
                        </strong>
                      </div>

                    </div>

                    <div
                      style={{
                        width: "100%",
                        height: "12px",
                        background: "#e5e7eb",
                        borderRadius: "999px",
                        overflow: "hidden",
                        marginBottom: "12px"
                      }}
                    >
                      <div
                        style={{
                          width: `${safetyScore}%`,
                          height: "100%",
                          background:
                            safetyScore >= 75
                              ? "#16a34a"
                              : safetyScore >= 60
                              ? "#65a30d"
                              : safetyScore >= 45
                              ? "#f59e0b"
                              : "#dc2626",
                          borderRadius: "999px",
                          transition: "width 0.5s ease"
                        }}
                      />
                    </div>

                    <p
                      style={{
                        margin: 0,
                        color: "#374151",
                        fontSize: "0.92rem",
                        lineHeight: 1.5
                      }}
                    >
                      This is the final safety prediction produced by the
                      SafeRoute V1 deep-learning model after combining the
                      traffic, nighttime lighting, weather, crime, and
                      emergency-accessibility features.
                    </p>

                  </div>


                  {/* ==========================================
                      FEATURE SUMMARY
                  ========================================== */}

                  <div className="feature-summary">

                    <h3>
                      📊 Route Feature Summary
                    </h3>


                    <div className="summary-grid">

                      <div>

                        <span>
                          🌙 Lighting
                        </span>

                        <strong>
                          {lightingScore}/100
                        </strong>

                      </div>


                      <div>

                        <span>
                          🚗 Traffic
                        </span>

                        <strong>
                          {trafficScore}/100
                        </strong>

                      </div>


                      <div>

                        <span>
                          🌦️ Weather
                        </span>

                        <strong>
                          {weatherScore}/100
                        </strong>

                      </div>


                      <div>

                        <span>
                          🔴 Crime Safety
                        </span>

                        <strong>
                          {crimeSafetyScore}/100
                        </strong>

                      </div>

                    </div>


                    <p className="feature-note">

                      These are individual route features.
                      They are not the final safety prediction.

                    </p>

                  </div>

                </div>

              );

            }
          )}

        </section>

      )}


      {/* ====================================================
          INITIAL MESSAGE
      ==================================================== */}

      {!loading &&
        routes.length === 0 &&
        !error && (

          <div className="welcome-message">

            <h2>
              🛡️ Find a Safer Route
            </h2>

            <p>
              Enter your source and destination to
              generate multiple route options.
            </p>

            <p>
              The system currently analyzes:
            </p>

            <div className="feature-list">

              <span>
                🌙 NASA Nighttime Lighting
              </span>

              <span>
                🚗 TomTom Real-Time Traffic
              </span>

              <span>
                🌦️ Open-Meteo Live Weather
              </span>

              <span>
                🔴 City & District Crime Data
              </span>

              <span>
                🧠 V1 Deep-Learning Safety Prediction
              </span>

              <span>
                🧭 Live Moving GPS Navigation Pointer
              </span>

              <span>
                🔄 Automatic Off-Route Rerouting
              </span>

              <span>
                🟢 Live Location Sharing
              </span>

            </div>

          </div>

        )}


      {/* ====================================================
          FOOTER
      ==================================================== */}

      <footer className="app-footer">

        <p>
          Safe Route Finder • Multi-Factor AI Safety Analysis
        </p>

      </footer>

    </div>

  );

}


export default App;