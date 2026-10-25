# User interface plan for motorola spectra codeplug reader/editor utility

## Current state: 
Documentation and python examples which can convert motorola codeplug files to CSV and YAML files. 

## Method of UI:

The UI shall be purely in html+css+javascript. This is so I can host it using github.io. 

Javascript tools: External javascripts shall be downloaded so that this repo can be run stand-alone without the internet. You may, however, write a shell script to wget/curl for updated versions. We will keep these external scripts in our repo, and not as a submodule -- keep what is needed as a copy. Note the scripts used, versions, and licenses somewhere. 

A simple python https server for testing shall also be provided to you, for testing only, not deployment. 

Make it so you can easily drive and monitor the UI, ie, an API that you can interact with for testing. 

Modularity is important. We may discover new things about the codeplug formats and will appreciate the ability to update. I prefer some separate javascript files to further increase the apparent modularity. 

## Features of the UI
Import code plug, import modified CSV/YAMLs, edit codeplug, export code plug, export CSV/YAMLs. 

Display radio information (as best we know it anyway). Display information which we can't edit but you can decode (if such things exist). 

Hex editor-style display of decrypted codeplug data, with string on side (like hexdump -C) No editing permitted yet. 

About button, text for about button to live in independent file for ease of updates. 

## Appearance and Design

Dark mode, tabs for different areas of the program similar to the RSS categories. "General Info" , "Radio-Wide", "Conventional", "Mode", "Control Head"

Initial codeplug load: Information tab called "General Info", shows radio model, customer, serial, date from codeplug file, number of modes, number of zones, radio features, size of decrypted codeplug in bytes, number of 'codeplug blocks' (MRSS reports this -- ok to omit if the unit is not obvious), radio's max supported codeplug size, decryption key in hex, radio band (VHF low, 900 MHz, etc), type of control head

// Maybe not.. Status line at top to say what is happening, ie, "Importing..." etc 

Zone, scan list, modes: spreadsheet-style chart editor, can move/delete/insert/add/duplicate

"Edit" button as first column on mode editor, brings up single-mode modal editor (may be easier than scrolling across a large spreadsheet)

Control head button assignment: Depict a control head, drop-down menus for button assignment choices. Allow buttons to be assigned to things RSS wouldn't allow -- list these below a "hack" divider in the drop down menu. I will eventually provide to you an SVG with labeled elements for this depiction. For now, just a list of buttons with drop down menus. 

## Export: 
On exporti codeplug, modal dialog: 
Show the total size of the decrpyted codeplug in bytes that is to be created. 
Show number of modes, number of zones
Show the filename of the new codeplug -- can we change the filename or is it necessary to be the same?
Show the radio model and serial number.
"Press OK to export" and then show progress bar, "done" when done. 

On export YAML and CSV, just perform the operation



## Other: 

## Trunking: 
Modal dialog on import, choice: 1: preserve trunking (no trunk editing available), 2: Attempt to remove trunking. If it's known that this model we can't remove trunking, just modal warn the user that there is trunking and that we will do our best to preserve that trunking data, and that we can't remove it for that model yet. 

## Validation: 
Do not validate frequencies: so long as you can encode them, encode them. For example, a radio rated for 146-174 MHz shall accept a frequency of 144.0, since we can encode it. 

Zones: We shall allow zones and modes to be edited without fuss. When it's time to export the codeplug, we modal dialog tell the user if there are unassigned channels, or if the home zone isn't defined, etc. For home zone, offer a drop down for selection of the home zone and/or home channel. Offer a button to "Place unzoned modes in a new zone named UNZONED". 

Talk around: Allow TA even on simplex channels, but warn within the mode editor that it isn't supported. The warning is not modal, it's just text that appears below the editor. 


### Log and Debug functions:
A log file view at the bottom, featuring a debug checkbox (default off). Log file contains date/time string followed by events and levels of these events (Debug, Info, Warning, Error, etc). The log can be exported as a text file. 
