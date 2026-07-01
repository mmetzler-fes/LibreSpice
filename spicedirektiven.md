Für die Simulation sollte es ein Menü "Configure Analysis" geben mit Unterpunkten und Parametern:
- Transient:
    Stop time
    Tim to start saving data
    Maximum Timestep
    Option Skik initial operating point solution
- AC Analysis:
    Type of sweep (linear, octave, decade, list)
    für octave - parameter: Number of points per octave, start frequency, stop frequency
    für decade - parameter: Number of points per decade, start frequency, stop frequency
    für linear - parameter: Number of points, start frequency, stop frequency
    für list - parameter: 1st frequency, 2nd frequency, 3rd frequency 
- DC sweep
    1st source:
        Name of 1st source to sweep
        Type of sweep (linear, octave, decade, list)
        start value
        stop value
        increment
- DC op pnt
