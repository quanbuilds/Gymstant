on cleanText(rawText)
  set valueText to rawText as text
  set AppleScript's text item delimiters to {return, linefeed, "|"}
  set pieces to text items of valueText
  set AppleScript's text item delimiters to " "
  set valueText to pieces as text
  set AppleScript's text item delimiters to ""
  return valueText
end cleanText

tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  if not (exists window 1 of frontProcess) then return ""
  set outputLines to {}
  set allElements to entire contents of window 1 of frontProcess
  repeat with uiElement in allElements
    try
      set elementRole to role of uiElement as text
      set elementDescription to ""
      set elementTitle to ""
      set elementValue to ""
      try
        set elementDescription to description of uiElement as text
      end try
      try
        set elementTitle to title of uiElement as text
      end try
      try
        set elementValue to value of uiElement as text
      end try
      set elementPosition to position of uiElement
      set elementSize to size of uiElement
      set elementText to my cleanText(elementRole & " " & elementDescription & " " & elementTitle & " " & elementValue)
      if (item 1 of elementSize) > 2 and (item 2 of elementSize) > 2 and elementText is not "" then
        set end of outputLines to ((item 1 of elementPosition) as text) & "|" & ((item 2 of elementPosition) as text) & "|" & ((item 1 of elementSize) as text) & "|" & ((item 2 of elementSize) as text) & "|" & elementText
      end if
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return outputLines as text
end tell
