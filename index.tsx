
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import * as PIXI from 'pixi.js';
import _ from 'lodash';

// --- Simple seedable random number generator ---
// A simple Alea PRNG implementation, as 'seedrandom' library is not available.
class SeededRandom {
    private s0: number;
    private s1: number;
    private s2: number;
    private c: number;

    constructor(seed: any) {
        let mash = this.mash();
        this.s0 = mash(' ');
        this.s1 = mash(' ');
        this.s2 = mash(' ');
        this.c = 1;

        if (seed) {
            const seedStr = seed.toString();
            this.s0 -= mash(seedStr);
            if (this.s0 < 0) this.s0 += 1;
            this.s1 -= mash(seedStr);
            if (this.s1 < 0) this.s1 += 1;
            this.s2 -= mash(seedStr);
            if (this.s2 < 0) this.s2 += 1;
        }
    }

    private mash() {
        let n = 0xefc8249d;
        return function(data: string) {
            data = data.toString();
            for (let i = 0; i < data.length; i++) {
                n += data.charCodeAt(i);
                let h = 0.02519603282416938 * n;
                n = h >>> 0;
                h -= n;
                h *= n;
                n = h >>> 0;
                h -= n;
                n += h * 0x100000000; // 2^32
            }
            return (n >>> 0) * 2.3283064365386963e-10; // 2^-32
        };
    }

    public random(): number {
        const t = 2091639 * this.s0 + this.c * 2.3283064365386963e-10; // 2^-32
        this.s0 = this.s1;
        this.s1 = this.s2;
        return this.s2 = t - (this.c = t | 0);
    }
}

// --- Constants ---
const CONSTANTS = {
    mapGeneration: {
        SEGMENT_COUNT_LIMIT: 2000,
        DEBUG: false,
        DRAW_HEATMAP: false,
        ROAD_SNAP_DISTANCE: 50,
        DEFAULT_SEGMENT_LENGTH: 300,
        HIGHWAY_SEGMENT_LENGTH: 400,
        DEFAULT_SEGMENT_WIDTH: 6,
        HIGHWAY_SEGMENT_WIDTH: 16,
        MINIMUM_INTERSECTION_DEVIATION: 30,
        HIGHWAY_BRANCH_POPULATION_THRESHOLD: 0.1,
        NORMAL_BRANCH_POPULATION_THRESHOLD: 0.1,
        DEFAULT_BRANCH_PROBABILITY: 0.4,
        HIGHWAY_BRANCH_PROBABILITY: 0.05,
        HEAT_MAP_PIXEL_DIM: 50,
        QUADTREE_PARAMS: { x: -20000, y: -20000, width: 40000, height: 40000 },
        QUADTREE_MAX_OBJECTS: 10,
        QUADTREE_MAX_LEVELS: 10,
    },
    gameLogic: {
        SELECT_PAN_THRESHOLD: 50,
        SELECTION_RANGE: 50,
    },
};

// --- Vector Math Utilities ---
const Vec = {
    subtract: (v1: PIXI.Point, v2: PIXI.Point) => new PIXI.Point(v1.x - v2.x, v1.y - v2.y),
    add: (v1: PIXI.Point, v2: PIXI.Point) => new PIXI.Point(v1.x + v2.x, v1.y + v2.y),
    multiplyScalar: (v: PIXI.Point, s: number) => new PIXI.Point(v.x * s, v.y * s),
    length: (v: PIXI.Point) => Math.sqrt(v.x * v.x + v.y * v.y),
    lengthSq: (v: PIXI.Point) => v.x * v.x + v.y * v.y,
    distance: (v1: PIXI.Point, v2: PIXI.Point) => Vec.length(Vec.subtract(v1, v2)),
    distanceSq: (v1: PIXI.Point, v2: PIXI.Point) => Vec.lengthSq(Vec.subtract(v1, v2)),
    dot: (v1: PIXI.Point, v2: PIXI.Point) => v1.x * v2.x + v1.y * v2.y,
    cross: (v1: PIXI.Point, v2: PIXI.Point) => v1.x * v2.y - v1.y * v2.x,
    angleBetween: (v1: PIXI.Point, v2: PIXI.Point) => Math.acos(Vec.dot(v1, v2) / (Vec.length(v1) * Vec.length(v2))) * (180 / Math.PI),
    fractionBetween: (v1: PIXI.Point, v2: PIXI.Point, frac: number) => new PIXI.Point(v1.x + (v2.x - v1.x) * frac, v1.y + (v2.y - v1.y) * frac),
    sinDegrees: (deg: number) => Math.sin(deg * Math.PI / 180),
    cosDegrees: (deg: number) => Math.cos(deg * Math.PI / 180),
    distanceToLineSq: (p: PIXI.Point, v: PIXI.Point, w: PIXI.Point) => {
        const l2 = Vec.distanceSq(v, w);
        // FIX: The function sometimes returned a number, causing a destructuring error.
        // It's now modified to always return an object with dist2, point, and t.
        if (l2 === 0) return { dist2: Vec.distanceSq(p, v), point: v.clone(), t: 0 };
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        const projection = new PIXI.Point(v.x + t * (w.x - v.x), v.y + t * (w.y - v.y));
        return { dist2: Vec.distanceSq(p, projection), point: projection, t };
    },
     doLineSegmentsIntersect: (p1: PIXI.Point, q1: PIXI.Point, p2: PIXI.Point, q2: PIXI.Point) => {
        const r = Vec.subtract(q1, p1);
        const s = Vec.subtract(q2, p2);
        const rxs = Vec.cross(r, s);
        const qp = Vec.subtract(p2, p1);
        const qpxr = Vec.cross(qp, r);

        if (rxs === 0) return null; // Parallel or collinear

        const t = Vec.cross(qp, s) / rxs;
        const u = qpxr / rxs;

        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            return { point: Vec.add(p1, Vec.multiplyScalar(r, t)), t };
        }
        return null;
    }
};

// --- Quadtree (simple implementation) ---
class Quadtree {
    private bounds: PIXI.Rectangle;
    private maxObjects: number;
    private maxLevels: number;
    private level: number;
    private objects: any[];
    private nodes: Quadtree[];

    constructor(bounds: PIXI.Rectangle, maxObjects = 10, maxLevels = 4, level = 0) {
        this.bounds = bounds;
        this.maxObjects = maxObjects;
        this.maxLevels = maxLevels;
        this.level = level;
        this.objects = [];
        this.nodes = [];
    }

    split() {
        const nextLevel = this.level + 1;
        const subWidth = this.bounds.width / 2;
        const subHeight = this.bounds.height / 2;
        const x = this.bounds.x;
        const y = this.bounds.y;

        this.nodes[0] = new Quadtree(new PIXI.Rectangle(x + subWidth, y, subWidth, subHeight), this.maxObjects, this.maxLevels, nextLevel);
        this.nodes[1] = new Quadtree(new PIXI.Rectangle(x, y, subWidth, subHeight), this.maxObjects, this.maxLevels, nextLevel);
        this.nodes[2] = new Quadtree(new PIXI.Rectangle(x, y + subHeight, subWidth, subHeight), this.maxObjects, this.maxLevels, nextLevel);
        this.nodes[3] = new Quadtree(new PIXI.Rectangle(x + subWidth, y + subHeight, subWidth, subHeight), this.maxObjects, this.maxLevels, nextLevel);
    }

    getIndex(rect: PIXI.Rectangle) {
        const midX = this.bounds.x + this.bounds.width / 2;
        const midY = this.bounds.y + this.bounds.height / 2;
        const topQuadrant = rect.y < midY && rect.y + rect.height < midY;
        const bottomQuadrant = rect.y > midY;

        if (rect.x < midX && rect.x + rect.width < midX) {
            if (topQuadrant) return 1;
            if (bottomQuadrant) return 2;
        } else if (rect.x > midX) {
            if (topQuadrant) return 0;
            if (bottomQuadrant) return 3;
        }
        return -1;
    }

    insert(obj: { collider: { limits(): PIXI.Rectangle }}) {
        const rect = obj.collider.limits();
        if (this.nodes.length) {
            const index = this.getIndex(rect);
            if (index !== -1) {
                this.nodes[index].insert(obj);
                return;
            }
        }

        this.objects.push(obj);

        if (this.objects.length > this.maxObjects && this.level < this.maxLevels) {
            if (!this.nodes.length) {
                this.split();
            }
            let i = 0;
            while (i < this.objects.length) {
                const index = this.getIndex(this.objects[i].collider.limits());
                if (index !== -1) {
                    this.nodes[index].insert(this.objects.splice(i, 1)[0]);
                } else {
                    i++;
                }
            }
        }
    }

    retrieve(rect: PIXI.Rectangle): any[] {
        let returnObjects = this.objects;
        const index = this.getIndex(rect);

        if (this.nodes.length) {
            if (index !== -1) {
                returnObjects = returnObjects.concat(this.nodes[index].retrieve(rect));
            } else {
                for (let i = 0; i < this.nodes.length; i++) {
                    returnObjects = returnObjects.concat(this.nodes[i].retrieve(rect));
                }
            }
        }

        return returnObjects;
    }
    
    clear() {
        this.objects = [];
        for (let i = 0; i < this.nodes.length; i++) {
            this.nodes[i].clear();
        }
        this.nodes = [];
    }
}


// --- City Generation Logic ---
let random: SeededRandom;

class Segment {
    static nextId = 0;
    id: number;
    r: { start: PIXI.Point; end: PIXI.Point };
    t: number;
    q: { highway?: boolean, color?: number, severed?: boolean };
    width: number;
    links: { f: Segment[]; b: Segment[] };
    _dir: number | null = null;
    _length: number | null = null;
    collider: { limits: () => PIXI.Rectangle };

    constructor(start: PIXI.Point, end: PIXI.Point, t: number, q: any) {
        this.id = Segment.nextId++;
        this.r = { start: start.clone(), end: end.clone() };
        this.t = t;
        this.q = { ...q };
        this.width = this.q.highway ? CONSTANTS.mapGeneration.HIGHWAY_SEGMENT_WIDTH : CONSTANTS.mapGeneration.DEFAULT_SEGMENT_WIDTH;
        this.links = { f: [], b: [] };

        this.collider = {
            limits: () => {
                const minX = Math.min(this.r.start.x, this.r.end.x) - this.width;
                const minY = Math.min(this.r.start.y, this.r.end.y) - this.width;
                const maxX = Math.max(this.r.start.x, this.r.end.x) + this.width;
                const maxY = Math.max(this.r.start.y, this.r.end.y) + this.width;
                return new PIXI.Rectangle(minX, minY, maxX - minX, maxY - minY);
            }
        };
    }

    get dir() {
        if (this._dir === null) {
            const d = Vec.subtract(this.r.end, this.r.start);
            this._dir = Math.atan2(d.y, d.x) * (180 / Math.PI) - 90;
        }
        return this._dir;
    }

    get length() {
        if (this._length === null) {
            this._length = Vec.distance(this.r.start, this.r.end);
        }
        return this._length;
    }

    neighbours() {
        return [...this.links.f, ...this.links.b];
    }

    endContaining(s: Segment) {
        if (this.links.f.includes(s)) return 'end';
        if (this.links.b.includes(s)) return 'start';
        return null;
    }
}

class PopulationMap {
    // Simple placeholder for original simplex noise logic
    populationAt(x: number, y: number) {
        // A simple function to simulate population density
        const scale = 5000;
        const d = Math.sqrt(x*x + y*y) / scale;
        return Math.max(0, 1 - d*d);
    }
}

// ... more ported classes if needed...
class PathLocation {
    o: Segment;
    fraction: number;
    constructor(o: Segment, fraction: number) {
        this.o = o;
        this.fraction = fraction;
    }
}

const cityGenerator = {
    generate(seed: number, segmentLimit: number) {
        Segment.nextId = 0;
        random = new SeededRandom(seed);
        const populationMap = new PopulationMap();
        
        const qTree = new Quadtree(new PIXI.Rectangle(
            CONSTANTS.mapGeneration.QUADTREE_PARAMS.x,
            CONSTANTS.mapGeneration.QUADTREE_PARAMS.y,
            CONSTANTS.mapGeneration.QUADTREE_PARAMS.width,
            CONSTANTS.mapGeneration.QUADTREE_PARAMS.height
        ));
        
        const segments: Segment[] = [];
        const queue: Segment[] = [];

        const startSeg = new Segment(new PIXI.Point(-CONSTANTS.mapGeneration.HIGHWAY_SEGMENT_LENGTH/2, 0), new PIXI.Point(CONSTANTS.mapGeneration.HIGHWAY_SEGMENT_LENGTH/2, 0), 0, { highway: true });
        queue.push(startSeg);

        while(queue.length > 0 && segments.length < segmentLimit) {
            queue.sort((a,b) => a.t - b.t);
            const current = queue.shift()!;
            
            if (!this.checkAndResolveIntersections(current, segments, qTree)) {
                continue;
            }

            segments.push(current);
            qTree.insert(current);
            
            const newSegments = this.generateNewSegments(current, populationMap);
            queue.push(...newSegments);
        }
        return { segments, qTree, populationMap };
    },

    checkAndResolveIntersections(segment: Segment, existingSegments: Segment[], qTree: Quadtree) {
        const near = qTree.retrieve(segment.collider.limits());
        let closestIntersection: { t: number, point: PIXI.Point, seg: Segment } | null = null;
        
        for (const other of near) {
            if (other === segment) continue;
            
            const intersection = Vec.doLineSegmentsIntersect(segment.r.start, segment.r.end, other.r.start, other.r.end);
            if (intersection && intersection.t > 0.001 && intersection.t < 0.999) {
                 if (!closestIntersection || intersection.t < closestIntersection.t) {
                    closestIntersection = { ...intersection, seg: other };
                }
            }
        }
        
        if (closestIntersection) {
            segment.r.end = closestIntersection.point.clone();
            segment.q.severed = true;
            // Simplified split logic: just connect them
            segment.links.f.push(closestIntersection.seg);
            closestIntersection.seg.links.f.push(segment); // This is not a proper junction, just connecting
        }
        
        return true;
    },

    generateNewSegments(parent: Segment, popMap: PopulationMap) {
        const newSegments: Segment[] = [];
        const pop = popMap.populationAt(parent.r.end.x, parent.r.end.y);

        const forward = this.createSegment(parent.r.end, parent.dir, parent.q.highway ? CONSTANTS.mapGeneration.HIGHWAY_SEGMENT_LENGTH : CONSTANTS.mapGeneration.DEFAULT_SEGMENT_LENGTH, parent.t + 1, parent.q);
        
        if (parent.q.highway) {
            const straight = this.createSegment(parent.r.end, parent.dir + (random.random() - 0.5) * 15, CONSTANTS.mapGeneration.HIGHWAY_SEGMENT_LENGTH, parent.t + 1, { highway: true });
            newSegments.push(straight);

            if (pop > CONSTANTS.mapGeneration.HIGHWAY_BRANCH_POPULATION_THRESHOLD && random.random() < CONSTANTS.mapGeneration.HIGHWAY_BRANCH_PROBABILITY) {
                 const branch = this.createSegment(parent.r.end, parent.dir + 90 * (random.random() > 0.5 ? 1 : -1), CONSTANTS.mapGeneration.DEFAULT_SEGMENT_LENGTH, parent.t + 5, {});
                 newSegments.push(branch);
            }
        } else {
             newSegments.push(forward);
             if (pop > CONSTANTS.mapGeneration.NORMAL_BRANCH_POPULATION_THRESHOLD && random.random() < CONSTANTS.mapGeneration.DEFAULT_BRANCH_PROBABILITY) {
                 const branch = this.createSegment(parent.r.end, parent.dir + 90 * (random.random() > 0.5 ? 1 : -1), CONSTANTS.mapGeneration.DEFAULT_SEGMENT_LENGTH, parent.t + 1, {});
                 newSegments.push(branch);
            }
        }

        newSegments.forEach(seg => {
            seg.links.b.push(parent);
            parent.links.f.push(seg);
        });

        return newSegments;
    },
    
    createSegment(start: PIXI.Point, dir: number, len: number, t: number, q: any) {
        const angle = (dir + 90) * (Math.PI / 180);
        const end = new PIXI.Point(start.x + len * Math.cos(angle), start.y + len * Math.sin(angle));
        return new Segment(start, end, t, q);
    }
};

const pathfinding = {
    find(startLoc: PathLocation, endLoc: PathLocation) {
        const frontier = new Array<{loc: Segment, priority: number}>();
        frontier.push({loc: startLoc.o, priority: 0});
        const cameFrom: Map<Segment, Segment | null> = new Map();
        const costSoFar: Map<Segment, number> = new Map();
        cameFrom.set(startLoc.o, null);
        costSoFar.set(startLoc.o, 0);

        while (frontier.length > 0) {
            frontier.sort((a,b) => a.priority - b.priority);
            const current = frontier.shift()!.loc;

            if (current === endLoc.o) break;

            for (const next of current.neighbours()) {
                const newCost = (costSoFar.get(current) || 0) + Vec.distance(current.r.end, next.r.start); // Simplified cost
                if (!costSoFar.has(next) || newCost < (costSoFar.get(next) || Infinity)) {
                    costSoFar.set(next, newCost);
                    const priority = newCost + Vec.distance(next.r.end, endLoc.o.r.start);
                    frontier.push({loc: next, priority});
                    cameFrom.set(next, current);
                }
            }
        }
        
        let current = endLoc.o;
        const path = [];
        while (current !== null) {
            path.push(current);
            if (current === startLoc.o) break;
            current = cameFrom.get(current)!;
        }
        return path.reverse();
    }
}


// --- React Component ---
const App: React.FC = () => {
    const pixiContainerRef = useRef<HTMLDivElement>(null);
    const appRef = useRef<PIXI.Application>();
    const worldRef = useRef<PIXI.Container>();
    const segmentsContainerRef = useRef<PIXI.Container>();
    const buildingsContainerRef = useRef<PIXI.Container>();
    const pathContainerRef = useRef<PIXI.Container>();
    const debugContainerRef = useRef<PIXI.Container>();
    const heatmapContainerRef = useRef<PIXI.Graphics>();

    const [segmentLimit, setSegmentLimit] = useState(CONSTANTS.mapGeneration.SEGMENT_COUNT_LIMIT);
    const [showDebug, setShowDebug] = useState(CONSTANTS.mapGeneration.DEBUG);
    const [showHeatmap, setShowHeatmap] = useState(CONSTANTS.mapGeneration.DRAW_HEATMAP);
    const [isPixiReady, setIsPixiReady] = useState(false);
    
    const cityDataRef = useRef<{segments: Segment[], qTree: Quadtree, populationMap: PopulationMap} | null>(null);
    const pathPointsRef = useRef<PathLocation[]>([]);

    const drawCity = useCallback((segments: Segment[]) => {
        if (!segmentsContainerRef.current) return;
        segmentsContainerRef.current.removeChildren();

        const highwayGraphics = new PIXI.Graphics();
        const roadGraphics = new PIXI.Graphics();

        for (const seg of segments) {
            const graphics = seg.q.highway ? highwayGraphics : roadGraphics;
            graphics.moveTo(seg.r.start.x, seg.r.start.y);
            graphics.lineTo(seg.r.end.x, seg.r.end.y);
        }

        highwayGraphics.stroke({ width: 16, color: 0xFFFF00 });
        roadGraphics.stroke({ width: 6, color: 0xFFFFFF });

        segmentsContainerRef.current.addChild(highwayGraphics, roadGraphics);
    }, []);
    
    const drawBuildings = useCallback((segments: Segment[], qTree: Quadtree) => {
        if (!buildingsContainerRef.current) return;
        buildingsContainerRef.current.removeChildren();
        const graphics = new PIXI.Graphics();
        graphics.beginFill(0x333333);
        
        segments.forEach(seg => {
            if (random.random() < 0.2) { // Place buildings near some segments
                const numBuildings = Math.floor(random.random() * 4);
                for (let i = 0; i < numBuildings; i++) {
                    const offset = (random.random() - 0.5) * 100 + Math.sign(random.random() - 0.5) * seg.width;
                    const posFrac = random.random();
                    const center = Vec.fractionBetween(seg.r.start, seg.r.end, posFrac);
                    const perp = Vec.subtract(seg.r.end, seg.r.start);
                    const temp = perp.x; perp.x = -perp.y; perp.y = temp;
                    const perpLen = Vec.length(perp);
                    if (perpLen > 0) {
                      perp.x /= perpLen;
                      perp.y /= perpLen;
                    }

                    const buildingCenter = Vec.add(center, Vec.multiplyScalar(perp, offset));
                    const size = random.random() * 15 + 10;
                    graphics.drawRect(buildingCenter.x - size/2, buildingCenter.y - size/2, size, size);
                }
            }
        });
        graphics.endFill();
        buildingsContainerRef.current.addChild(graphics);
    }, []);

    const drawHeatmap = useCallback((popMap: PopulationMap) => {
        if (!heatmapContainerRef.current || !worldRef.current) return;
        const graphics = heatmapContainerRef.current;
        graphics.clear();
        const dim = CONSTANTS.mapGeneration.HEAT_MAP_PIXEL_DIM;
        const worldBounds = worldRef.current.getBounds();

        for (let x = worldBounds.x; x < worldBounds.x + worldBounds.width; x += dim) {
            for (let y = worldBounds.y; y < worldBounds.y + worldBounds.height; y += dim) {
                const pop = popMap.populationAt(x + dim / 2, y + dim / 2);
                if (pop > 0.01) {
                    graphics.beginFill(0x00ff00, pop * 0.5);
                    graphics.drawRect(x, y, dim, dim);
                    graphics.endFill();
                }
            }
        }
    }, []);

    const regenerate = useCallback(() => {
        if (!worldRef.current || !pathContainerRef.current || !segmentsContainerRef.current || !buildingsContainerRef.current || !debugContainerRef.current || !heatmapContainerRef.current) return;
        
        pathPointsRef.current = [];
        pathContainerRef.current.removeChildren();
        segmentsContainerRef.current.removeChildren();
        buildingsContainerRef.current.removeChildren();
        debugContainerRef.current.removeChildren();
        heatmapContainerRef.current.clear();

        const data = cityGenerator.generate(new Date().getTime(), segmentLimit);
        cityDataRef.current = data;

        drawCity(data.segments);
        drawBuildings(data.segments, data.qTree);
        if (showHeatmap) drawHeatmap(data.populationMap);
    }, [segmentLimit, showHeatmap, drawCity, drawBuildings, drawHeatmap]);

    // Initializes the Pixi application. Runs only once on component mount.
    useEffect(() => {
        const container = pixiContainerRef.current;
        if (!container) return;

        let onWheelHandler: (e: WheelEvent) => void;

        const initPixi = async () => {
            const pixiApp = new PIXI.Application();
            await pixiApp.init({
                width: container.clientWidth,
                height: container.clientHeight,
                backgroundColor: 0x1e2c1e,
                antialias: true,
                resolution: window.devicePixelRatio || 1,
                autoDensity: true
            });
            appRef.current = pixiApp;

            while (container.firstChild) {
                container.removeChild(container.firstChild);
            }
            container.appendChild(pixiApp.canvas);

            const world = new PIXI.Container();
            worldRef.current = world;
            pixiApp.stage.addChild(world);
            
            heatmapContainerRef.current = new PIXI.Graphics();
            world.addChild(heatmapContainerRef.current);

            segmentsContainerRef.current = new PIXI.Container();
            world.addChild(segmentsContainerRef.current);

            buildingsContainerRef.current = new PIXI.Container();
            world.addChild(buildingsContainerRef.current);
            
            pathContainerRef.current = new PIXI.Container();
            world.addChild(pathContainerRef.current);

            debugContainerRef.current = new PIXI.Container();
            world.addChild(debugContainerRef.current);

            world.x = pixiApp.screen.width / 2;
            world.y = pixiApp.screen.height / 2;
            world.scale.set(0.1);

            pixiApp.stage.eventMode = 'static';
            pixiApp.stage.hitArea = pixiApp.screen;

            let dragging = false;
            let prevPos: PIXI.Point | null = null;
            pixiApp.stage.on('pointerdown', (e) => {
                dragging = true;
                prevPos = e.global.clone();
            });
            pixiApp.stage.on('pointerup', () => dragging = false);
            pixiApp.stage.on('pointerupoutside', () => dragging = false);
            pixiApp.stage.on('pointermove', (e) => {
                if (dragging && prevPos && worldRef.current) {
                    const newPos = e.global.clone();
                    worldRef.current.x += newPos.x - prevPos.x;
                    worldRef.current.y += newPos.y - prevPos.y;
                    prevPos = newPos;
                }
            });

            pixiApp.stage.on('click', (e) => {
                if (!cityDataRef.current || !worldRef.current) return;
                const pos = worldRef.current.toLocal(e.global);
                
                let closestDistSq = Infinity;
                let closestSeg: Segment | null = null;
                let closestT = 0;
                
                const searchRect = new PIXI.Rectangle(pos.x - 50, pos.y - 50, 100, 100);
                const candidates = cityDataRef.current.qTree.retrieve(searchRect);
                
                for(const segObj of candidates) {
                    const seg = segObj as Segment;
                    const { dist2, t } = Vec.distanceToLineSq(pos, seg.r.start, seg.r.end);
                    if (dist2 < closestDistSq) {
                        closestDistSq = dist2;
                        closestSeg = seg;
                        closestT = t;
                    }
                }

                if (closestSeg && Math.sqrt(closestDistSq) < CONSTANTS.gameLogic.SELECTION_RANGE / worldRef.current.scale.x) {
                    const newPathPoint = new PathLocation(closestSeg, closestT);
                    pathPointsRef.current.push(newPathPoint);

                    const pointGraphic = new PIXI.Graphics();
                    const worldPos = Vec.fractionBetween(closestSeg.r.start, closestSeg.r.end, closestT);
                    pointGraphic.beginFill(0xff0000).drawCircle(worldPos.x, worldPos.y, 10 / worldRef.current.scale.x).endFill();
                    pathContainerRef.current?.addChild(pointGraphic);

                    if (pathPointsRef.current.length === 2) {
                        const path = pathfinding.find(pathPointsRef.current[0], pathPointsRef.current[1]);
                        const pathGraphic = new PIXI.Graphics();
                        pathGraphic.lineStyle(8 / worldRef.current.scale.x, 0xff0000, 0.7);
                        if (path.length > 0) {
                            pathGraphic.moveTo(path[0].r.start.x, path[0].r.start.y);
                            for(const p of path) {
                                 pathGraphic.lineTo(p.r.end.x, p.r.end.y);
                            }
                        }
                        pathContainerRef.current?.addChild(pathGraphic);

                        setTimeout(() => {
                            pathPointsRef.current = [];
                            pathContainerRef.current?.removeChildren();
                        }, 5000);
                    }
                }
            });
            
            onWheelHandler = (e: WheelEvent) => {
                if (!worldRef.current) return;
                e.preventDefault();
                const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
                const pointerPosition = new PIXI.Point(e.clientX, e.clientY);
                const worldPos = worldRef.current.toLocal(pointerPosition);
                
                worldRef.current.scale.x *= scaleFactor;
                worldRef.current.scale.y *= scaleFactor;

                const newWorldPos = worldRef.current.toLocal(pointerPosition);
                
                worldRef.current.position.x -= (newWorldPos.x - worldPos.x) * worldRef.current.scale.x;
                worldRef.current.position.y -= (newWorldPos.y - worldPos.y) * worldRef.current.scale.y;
            };

            container.addEventListener('wheel', onWheelHandler, { passive: false });
            setIsPixiReady(true);
        };

        initPixi();

        return () => {
            setIsPixiReady(false);
            if (container && onWheelHandler) {
                container.removeEventListener('wheel', onWheelHandler);
            }
            if (appRef.current) {
                appRef.current.destroy(true, { children: true });
                appRef.current = undefined;
            }
        };
    }, []);

    // Triggers the initial city generation and subsequent regenerations.
    useEffect(() => {
        if (isPixiReady) {
            regenerate();
        }
    }, [isPixiReady, regenerate]);


    useEffect(() => {
        if(debugContainerRef.current) debugContainerRef.current.visible = showDebug;
    }, [showDebug]);

    useEffect(() => {
        if (heatmapContainerRef.current) {
            heatmapContainerRef.current.visible = showHeatmap;
            if (showHeatmap && cityDataRef.current) {
                drawHeatmap(cityDataRef.current.populationMap);
            }
        }
    }, [showHeatmap, drawHeatmap]);

    const handleZoom = (factor: number) => {
        if (!worldRef.current) return;
        worldRef.current.scale.x *= factor;
        worldRef.current.scale.y *= factor;
    };

    return (
        <div className="app-container">
            <header className="header">
                <h1>Procedural City Generation</h1>
                <p>Click and hold to navigate. Click on two locations to find a path.</p>
            </header>
            <div ref={pixiContainerRef} className="pixi-container" />
            <div className="control-bar">
                <button onClick={() => setShowDebug(p => !p)}>{showDebug ? 'Hide' : 'Show'} Debug</button>
                <button onClick={() => setShowHeatmap(p => !p)}>{showHeatmap ? 'Hide' : 'Show'} Heatmap</button>
                <button onClick={() => handleZoom(1.5)}>Zoom In</button>
                <button onClick={() => handleZoom(2/3)}>Zoom Out</button>
                <label htmlFor="segment-limit">Segment limit:</label>
                <input
                    id="segment-limit"
                    type="number"
                    min="100"
                    max="5000"
                    step="100"
                    value={segmentLimit}
                    onChange={(e) => setSegmentLimit(Number(e.target.value))}
                />
                <button onClick={regenerate} className="regenerate">Regenerate</button>
            </div>
        </div>
    );
};

const rootEl = document.getElementById('root');
if (rootEl) {
    const root = createRoot(rootEl);
    root.render(<App />);
}
