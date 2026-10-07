# Third-party notices

## MuscleMap (body artwork of the muscle map)

The front/back body figures of Heft's muscle map (`src/features/progress/bodyFigures.ts`) come from
**MuscleMap** by Melih Colpan: https://github.com/melihcolpan/MuscleMap (commit `7dc0307`).

What Heft changed: the SVG path data was converted from Swift (`Sources/MuscleMap/Data/*Paths.swift`) to a
TypeScript module by `scripts/build-body-map.mjs`; MuscleMap's sub-group marker shapes (hip flexors, upper/lower
chest, inner/outer quad, upper/lower abs, front/rear deltoid, upper/lower trapezius, serratus) were dropped; the
paths of one region were merged into one path; coordinates were translated into each figure's own box and rounded
to whole units. The shapes are otherwise unchanged.

```
MIT License

Copyright (c) 2026 Melih Colpan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
