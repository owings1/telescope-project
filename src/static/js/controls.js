$(document).ready(function() {

    function clearOutputs() {
        $('.output').text('')
    }

    var busy = false

    function sendCommand(command) {
        if (busy) {
            console.log('Busy, ignoring')
            return
        }
        busy = true
        $('.go').addClass('disabled').prop('disabled', true)
        clearOutputs()
        const req = {command}
        var opts = {
            method  : 'POST',
            body    : JSON.stringify(req),
            headers : {
                'Content-Type' : 'application/json'
            }
        }
        console.log('Sending', req)
        $('#request_output').text(JSON.stringify(req, null, 2))
        fetch('command/sync', opts).then(res => {
            busy = false
            $('.go').removeClass('disabled').prop('disabled', false)
            res.json().then(resBody => {
                console.log(resBody)
                $('#response_output').text(JSON.stringify(resBody, null, 2))
            }).catch(err => {
                console.error(err)
                $('#response_output').text(err)
            })
        }).catch(err => {
            busy = false
            $('.go').removeClass('disabled').prop('disabled', false)
            console.error(err)
            $('#response_output').text(err)
        })
    }

    $('form').on('submit', function(e) {
        console.log('submit')
        e.preventDefault()
    })
    $('form').on('click', function(e) {

        var $target = $(e.target)

        if ($target.hasClass('go')) {

            e.preventDefault()

            clearOutputs()

            if (busy || $target.hasClass('disabled') || $target.prop('disabled')) {
                return
            }

            var cmd
            try {

                if ($target.is('#home_1')) {
                    cmd = getHomeSingleCommand(1)
                } else if ($target.is('#home_2')) {
                    cmd = getHomeSingleCommand(2)
                } else if ($target.is('#home_all')) {
                    cmd = getHomeAllCommand()
                } else if ($target.is('#end_1')) {
                    cmd = getEndSingleCommand(1)
                } else if ($target.is('#end_2')) {
                    cmd = getEndSingleCommand(2)
                } else if ($target.is('#end_all')) {
                    cmd = getEndAllCommand()
                } else if ($target.is('#go_up')) {
                    cmd = getMoveDegreesCommand(1, 1)
                } else if ($target.is('#go_down')) {
                    cmd = getMoveDegreesCommand(1, 2)
                } else if ($target.is('#go_left')) {
                    cmd = getMoveDegreesCommand(2, 2)
                } else if ($target.is('#go_right')) {
                    cmd = getMoveDegreesCommand(2, 1)
                } else if ($target.is('#go_both')) {
                    cmd = getMoveDegreesBothCommand()
                }

                sendCommand(cmd)

            } catch (err) {
                console.error(err)
            }
        }
    })

    // :04 <motorId> <direction> <degrees>;
    function getMoveDegreesCommand(motorId, direction) {
        const degrees = $('#in_degrees').val()
        if (isNaN(parseFloat(degrees))) {
            throw new Error('Invalid degrees input: ' + degrees)
        }
        return [':04', motorId, direction, degrees].join(' ') + ';\n'
    }

    // :06 <motorId>;
    function getHomeSingleCommand(motorId) {
        return [':06', motorId].join(' ') + ';\n'
    }

    // :07 ;
    function getHomeAllCommand() {
        return ':07 ;\n'
    }

    // :08 <motorId>;
    function getEndSingleCommand(motorId) {
        return [':08', motorId].join(' ') + ';\n'
    }

    // :09 ;
    function getEndAllCommand() {
        return ':09 ;\n'
    }

    // :11 <direction_1> <degrees_1> <direction_2> <degrees_2>;
    function getMoveDegreesBothCommand() {
        const dir1 = parseInt($('#in_dir1').val())
        const dir2 = parseInt($('#in_dir2').val())
        const degrees1 = parseFloat($('#in_degrees1').val())
        const degrees2 = parseFloat($('#in_degrees2').val())
        if (dir1 != 1 && dir1 != 2) {
            throw new Error('Invalid direction_1 value: ' + dir1)
        }
        if (dir2 != 1 && dir2 != 2) {
            throw new Error('Invalid direction_2 value: ' + dir2)
        }
        if (isNaN(degrees1)) {
            throw new Error('Invalid degrees_1 value')
        }
        if (isNaN(degrees2)) {
            throw new Error('Invalid degrees_2 value')
        }
        return [':11', dir1, degrees1, dir2, degrees2].join(' ') + ';\n'
    }
})